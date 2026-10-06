import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  CHECK_IDS,
  REVIEW_CHECKS,
  REVIEWERS,
  approvalGate,
  buildReview,
  contentFingerprint,
  createDefaultDocuments,
  isSnapshotFresh,
  nextId,
  normalizeChecks,
  pushHistory,
  snapshotIdemKey,
  stamp,
  upgradeLegacyReview,
  type CheckId,
  type ConflictReason,
  type DisclosureRecord,
  type ProcessRecord,
  type Redaction,
  type ReviewerId,
  type ReviewState,
  type WorkingCopy
} from './reviewModel';

export type SnapshotFault = null | 'snapshot-fail' | 'snapshot-lost';

type SnapshotOp = { status: 'running' | 'recovering' | 'failed' | 'ok'; attempts: number; message?: string };
type UpgradeOp = { status: 'running' | 'failed' | 'done'; attempts: number; message?: string };

type CommittedWrite = { at: string; kind: 'snapshot' | 'upgrade'; recordId: string };

export type SubmitOutcome =
  | { ok: true; idempotent?: boolean }
  | { ok: false; code: 'no-draft' | 'no-decision' | 'snapshot-stale' | 'conflict'; reason?: ConflictReason; text?: string };

type State = {
  documents: DisclosureRecord[];
  activeDocumentId: string;
  activePage: number;
  activeRedactionId: string | null;
  redactionMode: boolean;
  qualityDocumentId: string;
  activeReviewer: ReviewerId;
  injectedFaults: { snapshot: SnapshotFault; upgrade: null | 'upgrade-fail' };
  /** 模拟服务端已落库写入：响应丢失后重试据此识别，保证快照只留一份 */
  committedWrites: Record<string, CommittedWrite>;
  snapshotOps: Record<string, SnapshotOp>;
  upgradeOps: Record<string, UpgradeOp>;

  selectDocument: (id: string) => void;
  setPage: (page: number) => void;
  toggleRedactionMode: () => void;
  selectRedaction: (id: string | null) => void;
  updateClassification: (classification: DisclosureRecord['classification']) => void;
  addRedaction: (redaction: Omit<Redaction, 'id' | 'status'>) => void;
  confirmRedaction: (id: string) => void;
  submitForQa: () => void;

  setQualityDocument: (id: string) => void;
  setActiveReviewer: (id: ReviewerId) => void;
  setInjectedFault: (patch: Partial<State['injectedFaults']>) => void;
  openWorkingCopy: (docId: string, reviewerId: ReviewerId) => void;
  updateWorkingDraft: (docId: string, reviewerId: ReviewerId, patch: Pick<WorkingCopy, 'decision'>) => void;
  acknowledgeCompared: (docId: string, reviewerId: ReviewerId) => void;
  submitConclusion: (docId: string, reviewerId: ReviewerId) => Promise<SubmitOutcome>;
  resolveConflict: (docId: string, mode: 'refresh' | 'discard') => void;
  toggleReviewCheck: (docId: string, checkId: CheckId) => void;
  toggleMetadata: (docId: string) => void;
  createSnapshot: (docId: string, reviewerId: ReviewerId) => Promise<void>;
  approveRelease: (docId: string) => void;
  resetReviewCycle: (docId: string) => void;

  recoverPendingUpgrades: () => void;
  retryUpgrade: (docId: string) => void;
  seedLegacyDraft: (forceFirstWriteFail: boolean) => void;
  resetDemo: () => void;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const actorName = (id: ReviewerId) => REVIEWERS.find((item) => item.id === id)?.name ?? id;

const snapshotAutoRetry = new Map<string, ReturnType<typeof setTimeout>>();

function patchDocument(documents: DisclosureRecord[], docId: string, fn: (doc: DisclosureRecord) => DisclosureRecord): DisclosureRecord[] {
  return documents.map((doc) => (doc.id === docId ? fn(doc) : doc));
}

function patchReview(doc: DisclosureRecord, fn: (review: ReviewState) => ReviewState): DisclosureRecord {
  return { ...doc, review: fn(doc.review) };
}

/** 区域 / 复核项变更：版本 +1，锁释放、快照留痕但指纹不再匹配（失效），双人需重新对照；已批准的文档退回待质检 */
function bumpContentVersion(doc: DisclosureRecord, actor: string, kind: ProcessRecord['kind'], text: string): DisclosureRecord {
  const nextVersion = doc.review.contentVersion + 1;
  const withStatus: DisclosureRecord = doc.status === '可发布'
    ? { ...doc, status: '待质检' }
    : doc;
  const lockSuffix = doc.review.lock ? '；旧版本锁释放' : '';
  const releasedSuffix = doc.status === '可发布' ? '；原批准状态撤回，文档退回待质检' : '';
  return patchReview(withStatus, (review) => pushHistory({
    ...review,
    contentVersion: nextVersion,
    lock: null,
    comparedBy: {}
  }, { actor, kind, version: nextVersion, text: `${text}；发布快照失效${lockSuffix}${releasedSuffix}` }));
}

export const useDisclosureStore = create<State>()(
  persist(
    (set, get) => {
      const updateDoc = (docId: string, fn: (doc: DisclosureRecord) => DisclosureRecord) =>
        set((state) => ({ documents: patchDocument(state.documents, docId, fn) }));

      const createSnapshotInternal = async (docId: string, reviewerId: ReviewerId, attempt: number): Promise<void> => {
        const inflight = get().snapshotOps[docId];
        if (inflight && (inflight.status === 'running' || inflight.status === 'recovering')) return;
        const current = get().documents.find((doc) => doc.id === docId);
        if (!current) return;
        const review = current.review;
        const idemKey = snapshotIdemKey(docId, review, current);

        // 幂等：同版本同指纹已有快照，直接复用，绝不重复留下
        if (isSnapshotFresh(current)) {
          set((state) => ({
            snapshotOps: { ...state.snapshotOps, [docId]: { status: 'ok', attempts: attempt, message: '当前版本已有发布快照，已复用，未重复生成' } }
          }));
          return;
        }

        set((state) => ({
          snapshotOps: { ...state.snapshotOps, [docId]: { status: attempt > 1 ? 'recovering' : 'running', attempts: attempt, message: attempt > 1 ? '正在按文档编号重试恢复…' : '正在写入发布快照…' } }
        }));
        await delay(480);

        const write = get().committedWrites[idemKey];
        if (write) {
          // 服务端其实已落库，只是上次响应丢失：恢复同一份快照
          updateDoc(docId, (doc) => {
            let r = doc.review;
            if (!r.snapshot || r.snapshot.idemKey !== idemKey) {
              r = {
                ...r,
                snapshot: { id: write.recordId, version: r.contentVersion, fingerprint: contentFingerprint(doc, r), createdAt: write.at, createdBy: reviewerId, idemKey }
              };
            }
            r = pushHistory(r, {
              id: write.recordId,
              at: write.at,
              actor: actorName(reviewerId),
              kind: 'snapshot',
              version: r.contentVersion,
              text: `原页/发布页对照完成，生成 v${r.contentVersion} 发布快照（幂等键 ${idemKey.slice(-10)}）`
            });
            r = pushHistory(r, {
              id: `${idemKey}-recovery`,
              actor: '系统',
              kind: 'recovery',
              version: r.contentVersion,
              text: `上次快照写入响应已丢失，按文档编号 ${doc.id} 重试恢复，沿用已落库快照，未重复生成`
            });
            return patchReview(doc, () => r);
          });
          set((state) => ({
            snapshotOps: { ...state.snapshotOps, [docId]: { status: 'ok', attempts: attempt, message: '检测到服务端已落库：重试恢复成功，未重复留下快照' } }
          }));
          return;
        }

        const fault = get().injectedFaults.snapshot;
        if (fault === 'snapshot-lost') {
          // 服务端已提交、响应在途中丢失：登记落库事实，等待幂等重试
          set((state) => ({
            injectedFaults: { ...state.injectedFaults, snapshot: null },
            committedWrites: {
              ...state.committedWrites,
              [idemKey]: { at: stamp(), kind: 'snapshot', recordId: `snap-${docId}-v${review.contentVersion}` }
            },
            snapshotOps: { ...state.snapshotOps, [docId]: { status: 'failed', attempts: attempt, message: '写入响应丢失（服务器可能已落库），将按文档编号自动重试…' } }
          }));
          const previous = snapshotAutoRetry.get(docId);
          if (previous) clearTimeout(previous);
          const timeout = setTimeout(() => { void createSnapshotInternal(docId, reviewerId, attempt + 1); }, 1300);
          snapshotAutoRetry.set(docId, timeout);
          return;
        }
        if (fault === 'snapshot-fail') {
          set((state) => ({
            injectedFaults: { ...state.injectedFaults, snapshot: null },
            snapshotOps: { ...state.snapshotOps, [docId]: { status: 'failed', attempts: attempt, message: `写入失败（模拟 HTTP 500）。可按文档编号 ${docId} 重试，不会重复留下快照` } }
          }));
          return;
        }

        updateDoc(docId, (doc) => patchReview(doc, (r) => {
          const fingerprint = contentFingerprint(doc, r);
          const withSnapshot: ReviewState = {
            ...r,
            snapshot: { id: `snap-${doc.id}-v${r.contentVersion}`, version: r.contentVersion, fingerprint, createdAt: stamp(), createdBy: reviewerId, idemKey }
          };
          return pushHistory(withSnapshot, {
            id: idemKey,
            actor: actorName(reviewerId),
            kind: 'snapshot',
            version: r.contentVersion,
            text: `原页/发布页对照完成，生成 v${r.contentVersion} 发布快照（区域 ${doc.redactions.length} 处、复核项 ${CHECK_IDS.filter((c) => r.checks[c]).length}/${CHECK_IDS.length} 通过）`
          });
        }));
        set((state) => ({
          snapshotOps: { ...state.snapshotOps, [docId]: { status: 'ok', attempts: attempt, message: attempt > 1 ? `第 ${attempt} 次尝试写入成功` : '发布快照已生成' } }
        }));
      };

      const runUpgradeInternal = (docId: string, attempt: number): void => {
        const current = get().documents.find((doc) => doc.id === docId);
        if (!current || !current.review.pendingUpgrade) return;
        const idemKey = `upgrade-${docId}`;
        set((state) => ({
          upgradeOps: { ...state.upgradeOps, [docId]: { status: 'running', attempts: attempt, message: attempt > 1 ? `正在按文档编号 ${docId} 重试升级恢复…` : '正在写入旧草稿升级结果…' } }
        }));
        void delay(420).then(() => {
          const doc = get().documents.find((item) => item.id === docId);
          if (!doc) return;
          const write = get().committedWrites[idemKey];
          if (write) {
            updateDoc(docId, (item) => patchReview(item, (r) => pushHistory({
              ...r,
              pendingUpgrade: false,
              upgradeAttempts: attempt
            }, {
              id: idemKey,
              at: write.at,
              actor: '系统',
              kind: 'upgrade',
              version: r.contentVersion,
              text: `旧草稿升级至版本模型 v1：原去密区域、复核勾选与处理记录均已保留`
            })));
            set((state) => ({
              upgradeOps: { ...state.upgradeOps, [docId]: { status: 'done', attempts: attempt, message: `重试恢复成功（文档编号 ${docId}），升级记录只写入一次` } }
            }));
            return;
          }
          if (get().injectedFaults.upgrade === 'upgrade-fail') {
            set((state) => ({
              injectedFaults: { ...state.injectedFaults, upgrade: null },
              committedWrites: { ...state.committedWrites, [idemKey]: { at: stamp(), kind: 'upgrade', recordId: idemKey } },
              upgradeOps: { ...state.upgradeOps, [docId]: { status: 'failed', attempts: attempt, message: `升级写入失败（模拟 HTTP 500，服务器可能已落库）。请按文档编号 ${docId} 重试恢复` } }
            }));
            return;
          }
          updateDoc(docId, (item) => patchReview(item, (r) => pushHistory({
            ...r,
            pendingUpgrade: false,
            upgradeAttempts: attempt
          }, {
            id: idemKey,
            actor: '系统',
            kind: 'upgrade',
            version: r.contentVersion,
            text: `旧草稿升级至版本模型 v1：原去密区域、复核勾选与处理记录均已保留`
          })));
          set((state) => ({
            upgradeOps: { ...state.upgradeOps, [docId]: { status: 'done', attempts: attempt, message: '旧草稿升级完成' } }
          }));
        });
      };

      return {
        documents: createDefaultDocuments(),
        activeDocumentId: 'DOC-00418',
        activePage: 1,
        activeRedactionId: 'R-02',
        redactionMode: false,
        qualityDocumentId: 'DOC-00427',
        activeReviewer: 'shen',
        injectedFaults: { snapshot: null, upgrade: null },
        committedWrites: {},
        snapshotOps: {},
        upgradeOps: {},

        selectDocument: (id) => set({ activeDocumentId: id, activePage: 1, activeRedactionId: null, redactionMode: false }),
        setPage: (page) => set({ activePage: page }),
        toggleRedactionMode: () => set((state) => ({ redactionMode: !state.redactionMode })),
        selectRedaction: (id) => set({ activeRedactionId: id }),
        updateClassification: (classification) =>
          updateDoc(get().activeDocumentId, (doc) => ({ ...doc, classification })),

        addRedaction: (redaction) => {
          const docId = get().activeDocumentId;
          const region: Redaction = { ...redaction, id: nextId('R'), status: 'draft' };
          updateDoc(docId, (item) => {
            const added: DisclosureRecord = { ...item, redactions: [...item.redactions, region] };
            return bumpContentVersion(added, item.owner, 'region', `${item.owner} 新增草稿去密区域（${region.reason}，第 ${region.page} 页）`);
          });
          set({ activeRedactionId: region.id });
        },
        confirmRedaction: (id) => updateDoc(get().activeDocumentId, (doc) => {
          const target = doc.redactions.find((item) => item.id === id);
          const redactions = doc.redactions.map((item) => (item.id === id ? { ...item, status: 'confirmed' as const } : item));
          const changed: DisclosureRecord = { ...doc, redactions };
          return bumpContentVersion(changed, doc.owner, 'region', `${doc.owner} 确认去密区域 ${id}（${target?.reason ?? ''}）`);
        }),
        submitForQa: () => {
          const docId = get().activeDocumentId;
          updateDoc(docId, (doc) => {
            if (doc.status === '待质检') return doc;
            const changed: DisclosureRecord = { ...doc, status: '待质检' };
            return patchReview(changed, (r) => pushHistory(r, { actor: doc.owner, kind: 'system', version: r.contentVersion, text: '提交质检，进入双人复核（内容版本不变）' }));
          });
        },

        setQualityDocument: (id) => set({ qualityDocumentId: id }),
        setActiveReviewer: (id) => set({ activeReviewer: id }),
        setInjectedFault: (patch) => set((state) => ({ injectedFaults: { ...state.injectedFaults, ...patch } })),

        openWorkingCopy: (docId, reviewerId) => updateDoc(docId, (doc) => patchReview(doc, (review) => {
          const existing = review.workingCopies.find((wc) => wc.reviewerId === reviewerId);
          if (existing && existing.basedOnVersion === review.contentVersion) return review;
          const observedLock = review.lock && review.lock.version === review.contentVersion ? { ...review.lock } : null;
          const wc: WorkingCopy = {
            id: nextId('wc'),
            reviewerId,
            openedAt: stamp(),
            basedOnVersion: review.contentVersion,
            observedLock,
            lockSeenAtOpen: !!observedLock,
            checks: normalizeChecks(review.checks),
            metadataAck: review.metadataCleaned,
            comparedVersion: review.comparedBy[reviewerId] === review.contentVersion ? review.contentVersion : null,
            decision: null
          };
          const copies = review.workingCopies.filter((item) => item.reviewerId !== reviewerId).concat(wc);
          if (!existing) {
            return pushHistory({ ...review, workingCopies: copies }, {
              actor: actorName(reviewerId),
              kind: 'draft',
              version: review.contentVersion,
              text: `${actorName(reviewerId)} 打开复核工作稿，基于 v${review.contentVersion}${wc.observedLock ? `，该版本已由 ${actorName(wc.observedLock.by)} 锁定` : '，版本尚未锁定'}`
            });
          }
          // 显式刷新：旧工作稿对齐到最新版本，旧决定/对照状态作废（防止旧结论进入发布）
          return pushHistory({ ...review, workingCopies: copies, comparedBy: { ...review.comparedBy, [reviewerId]: undefined } }, {
            actor: actorName(reviewerId),
            kind: 'draft',
            version: review.contentVersion,
            text: `${actorName(reviewerId)} 的工作稿由 v${existing.basedOnVersion} 刷新对齐到 v${review.contentVersion}；原结论作废，需重新对照`
          });
        })),

        updateWorkingDraft: (docId, reviewerId, patch) => updateDoc(docId, (doc) => patchReview(doc, (review) => ({
          ...review,
          workingCopies: review.workingCopies.map((wc) => (wc.reviewerId === reviewerId ? { ...wc, ...patch } : wc))
        }))),

        acknowledgeCompared: (docId, reviewerId) => updateDoc(docId, (doc) => {
          if (!isSnapshotFresh(doc)) return doc; // 快照失效时必须先生成快照
          return patchReview(doc, (review) => {
            if (review.comparedBy[reviewerId] === review.contentVersion) return review;
            const withAck = { ...review, comparedBy: { ...review.comparedBy, [reviewerId]: review.contentVersion } };
            const withWc = {
              ...withAck,
              workingCopies: withAck.workingCopies.map((wc) => (wc.reviewerId === reviewerId ? { ...wc, comparedVersion: review.contentVersion } : wc))
            };
            return pushHistory(withWc, {
              actor: actorName(reviewerId),
              kind: 'compare',
              version: review.contentVersion,
              text: `逐页重新对照原页与发布页完成，确认与 v${review.contentVersion} 快照一致`
            });
          });
        }),

        submitConclusion: async (docId, reviewerId) => {
          const working = get().documents.find((doc) => doc.id === docId)?.review.workingCopies.find((wc) => wc.reviewerId === reviewerId);
          if (!working) return { ok: false, code: 'no-draft', text: '请先以该复核员身份打开工作稿' };
          if (!working.decision) return { ok: false, code: 'no-decision', text: '请先选择复核结论（通过 / 退回补件）' };

          await delay(520);

          const doc = get().documents.find((item) => item.id === docId);
          if (!doc) return { ok: false, code: 'no-draft' };
          const review = doc.review;
          const fingerprint = contentFingerprint(doc, review);
          const existing = review.conclusions.find((c) => c.reviewerId === reviewerId && c.version === review.contentVersion);
          if (existing) {
            return { ok: false, code: 'conflict', reason: 'duplicate', text: `你已在 v${review.contentVersion} 提交过结论，无需重复提交` };
          }

          let reason: ConflictReason | null = null;
          if (working.basedOnVersion !== review.contentVersion) {
            reason = 'version-moved';
          } else if (review.lock && review.lock.version === review.contentVersion && !working.lockSeenAtOpen && review.lock.by !== reviewerId) {
            // 两人基于同一版本各自打开工作稿，先到者已锁定：后到者提交即冲突
            reason = 'locked-by-other';
          }

          if (reason) {
            const reasonText = reason === 'version-moved'
              ? `提交基于 v${working.basedOnVersion}，但去密区域/复核项已变更到 v${review.contentVersion}`
              : `v${review.contentVersion} 已被 ${actorName(review.lock!.by)} 于 ${review.lock!.at} 先到锁定`;
            const conflict = {
              id: nextId('conf'),
              reviewerId,
              at: stamp(),
              reason,
              submittedVersion: working.basedOnVersion,
              currentVersion: review.contentVersion,
              lock: review.lock ? { ...review.lock } : null,
              workingCopy: { ...working, checks: { ...working.checks } },
              text: reasonText
            };
            updateDoc(docId, (item) => patchReview(item, (r) => pushHistory({ ...r, conflict }, {
              actor: actorName(reviewerId),
              kind: 'conflict',
              version: review.contentVersion,
              text: `${actorName(reviewerId)} 的提交遇到并发冲突：${reasonText}；其工作稿与勾选现场已保留，可刷新到最新版本后重新对照`
            })));
            return { ok: false, code: 'conflict', reason, text: reasonText };
          }

          // 版本一致但当前版本快照失效：不是冲突，必须重新对照生成快照
          if (working.decision === 'approve' && !isSnapshotFresh(doc)) {
            return { ok: false, code: 'snapshot-stale', text: `发布快照已失效（当前 v${review.contentVersion}），请重新对照原页与发布页并生成快照` };
          }

          updateDoc(docId, (item) => patchReview(item, (r) => {
            const at = stamp();
            const withLock: ReviewState = r.lock && r.lock.by === reviewerId
              ? r
              : { ...r, lock: { version: r.contentVersion, by: reviewerId, at } };
            const conclusion = {
              reviewerId,
              decision: working.decision as 'approve' | 'return',
              at,
              version: r.contentVersion,
              checkFingerprint: fingerprint
            };
            const withConclusion = {
              ...withLock,
              conclusions: [...withLock.conclusions.filter((c) => !(c.reviewerId === reviewerId && c.version === r.contentVersion)), conclusion],
              workingCopies: withLock.workingCopies.filter((wc) => wc.reviewerId !== reviewerId)
            };
            return pushHistory(withConclusion, {
              actor: actorName(reviewerId),
              kind: 'submit',
              version: r.contentVersion,
              text: working.decision === 'approve'
                ? `复核结论：通过；${r.lock && r.lock.by !== reviewerId ? '先到锁定本版本，' : ''}等待双人结论齐备`
                : '复核结论：退回补件'
            });
          }));
          return { ok: true };
        },

        resolveConflict: (docId, mode) => updateDoc(docId, (doc) => patchReview(doc, (review) => {
          if (!review.conflict) return review;
          const { reviewerId, currentVersion } = review.conflict;
          if (mode === 'discard') {
            return pushHistory({
              ...review,
              conflict: null,
              workingCopies: review.workingCopies.filter((wc) => wc.reviewerId !== reviewerId)
            }, { actor: actorName(reviewerId), kind: 'system', version: currentVersion, text: `${actorName(reviewerId)} 放弃冲突工作稿；现场已归档于处理记录` });
          }
          const refreshedObserved = review.lock && review.lock.version === review.contentVersion ? { ...review.lock } : null;
          const refreshed: WorkingCopy = {
            id: nextId('wc'),
            reviewerId,
            openedAt: stamp(),
            basedOnVersion: review.contentVersion,
            observedLock: refreshedObserved,
            // 冲突刷新后已在现场面板看到该锁，属于“知情后”的正常第二份结论，不再触发先到锁冲突
            lockSeenAtOpen: true,
            checks: normalizeChecks(review.checks),
            metadataAck: review.metadataCleaned,
            comparedVersion: null,
            // 旧决定保留在冲突现场记录中；工作稿上需重新下结论，避免旧结论误进发布
            decision: null
          };
          return pushHistory({
            ...review,
            conflict: null,
            // 旧工作稿（连同勾选现场）已归档在冲突记录里，这里替换为对齐最新版本的新工作稿
            workingCopies: review.workingCopies
              .filter((wc) => wc.reviewerId !== reviewerId)
              .concat(refreshed),
            comparedBy: { ...review.comparedBy, [reviewerId]: undefined }
          }, {
            actor: actorName(reviewerId),
            kind: 'system',
            version: review.contentVersion,
            text: `冲突现场已保留在处理记录，${actorName(reviewerId)} 已刷新到 v${review.contentVersion}；需重新逐页对照后才能再次提交`
          });
        })),

        toggleReviewCheck: (docId, checkId) => updateDoc(docId, (doc) => {
          const reviewerId = get().activeReviewer;
          const changed: DisclosureRecord = patchReview(doc, (r) => ({ ...r, checks: { ...r.checks, [checkId]: !r.checks[checkId] } }));
          const label = REVIEW_CHECKS.find((item) => item.id === checkId)?.label ?? checkId;
          const checked = changed.review.checks[checkId];
          return bumpContentVersion(changed, actorName(reviewerId), 'check', `${actorName(reviewerId)} 将复核项「${label}」${checked ? '勾选通过' : '取消勾选'}`);
        }),

        toggleMetadata: (docId) => updateDoc(docId, (doc) => {
          const reviewerId = get().activeReviewer;
          const next = !doc.review.metadataCleaned;
          const changed: DisclosureRecord = patchReview(doc, (r) => ({ ...r, metadataCleaned: next }));
          return bumpContentVersion(changed, actorName(reviewerId), 'check', `${actorName(reviewerId)} ${next ? '确认' : '撤销确认'}文档元数据清理`);
        }),

        createSnapshot: (docId) => { void createSnapshotInternal(docId, get().activeReviewer, 1); return Promise.resolve(); },

        approveRelease: (docId) => updateDoc(docId, (doc) => {
          if (!approvalGate(doc).ready) return doc;
          const version = doc.review.contentVersion;
          const changed: DisclosureRecord = { ...doc, status: '可发布' };
          return patchReview(changed, (r) => pushHistory(r, { actor: '双人复核', kind: 'release', version, text: `双人复核结论齐备并完成对照，批准基于 v${version} 快照发布` }));
        }),

        resetReviewCycle: (docId) => updateDoc(docId, (doc) => patchReview(doc, (r) => pushHistory({
          ...r,
          lock: null,
          conclusions: [],
          workingCopies: [],
          conflict: null,
          comparedBy: {}
        }, {
          actor: '系统',
          kind: 'system',
          version: r.contentVersion,
          text: `（演示）已重置 v${r.contentVersion} 的双人复核流程；发布快照保留，可重新演示先到锁定与冲突`
        }))),

        recoverPendingUpgrades: () => {
          for (const doc of get().documents) {
            if (doc.review.pendingUpgrade) {
              const op = get().upgradeOps[doc.id];
              if (op && (op.status === 'running' || op.status === 'done')) continue;
              runUpgradeInternal(doc.id, (op?.attempts ?? 0) + 1);
            }
          }
        },
        retryUpgrade: (docId) => {
          const op = get().upgradeOps[docId];
          runUpgradeInternal(docId, (op?.attempts ?? 0) + 1);
        },

        seedLegacyDraft: (forceFirstWriteFail) => {
          const docId = 'DOC-00901';
          if (get().documents.some((doc) => doc.id === docId)) return;
          const legacyChecks = normalizeChecks({ 'forbidden-terms': true, 'page-number': true, 'image-boundary': false, metadata: false });
          const legacyHistory: ProcessRecord[] = [
            { id: 'rec-legacy-2', at: '前日 17:22', actor: '周叙', kind: 'region', version: 0, text: '旧版工作台：确认补充协议附件的报价遮蔽区域' },
            { id: 'rec-legacy-1', at: '前日 16:40', actor: '周叙', kind: 'check', version: 0, text: '旧版工作台：勾选“全文禁词与姓名复核”' }
          ];
          const legacy: DisclosureRecord = {
            id: docId,
            title: '旧版草稿 · 供应商维保记录摘录',
            bundle: '北岭项目 · 第三批披露',
            pages: 3,
            classification: '机密',
            owner: '周叙',
            updatedAt: '前日 17:22',
            status: '待质检',
            issue: '维保与报价',
            size: '2.6 MB',
            redactions: [
              { id: 'R-91', page: 1, x: 0.14, y: 0.31, width: 0.52, height: 0.05, reason: '第三方报价', privilege: '商业敏感', status: 'confirmed' },
              { id: 'R-92', page: 2, x: 0.3, y: 0.58, width: 0.24, height: 0.04, reason: '联系人手机号', privilege: '个人信息', status: 'draft' }
            ],
            review: upgradeLegacyReview({ id: docId, redactions: [] }, { checks: legacyChecks, metadataCleaned: false, history: legacyHistory })
          };
          set((state) => ({
            documents: [...state.documents, legacy],
            qualityDocumentId: docId,
            injectedFaults: forceFirstWriteFail
              ? { ...state.injectedFaults, upgrade: 'upgrade-fail' }
              : state.injectedFaults
          }));
          runUpgradeInternal(docId, 1);
        },

        resetDemo: () => {
          try { localStorage.removeItem('yy59-disclosure-draft'); } catch { /* ignore */ }
          window.location.reload();
        }
      };
    },
    {
      name: 'yy59-disclosure-draft',
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        const state = persistedState as Record<string, unknown>;
        if (!state || version >= 2) return state;
        // v0/1 -> v2：旧草稿升级，保留原区域、勾选与处理记录；升级写入挂起，启动后按文档编号幂等恢复
        const oldDocs = Array.isArray(state.documents) ? (state.documents as DisclosureRecord[]) : [];
        const legacyChecks = (state.reviewChecks ?? null) as Record<string, boolean> | null;
        const legacyMeta = Boolean(state.metadataCleaned);
        const documents = oldDocs.map((doc) => doc.review
          ? doc
          : { ...doc, review: upgradeLegacyReview(doc, { checks: legacyChecks, metadataCleaned: legacyMeta }) });
        const { reviewChecks, metadataCleaned, ...rest } = state as Record<string, unknown>;
        void reviewChecks; void metadataCleaned;
        return { ...rest, documents, qualityDocumentId: 'DOC-00427', activeReviewer: 'shen', committedWrites: {}, snapshotOps: {}, upgradeOps: {} };
      }
    }
  )
);

export { approvalGate, isSnapshotFresh, buildReview };
