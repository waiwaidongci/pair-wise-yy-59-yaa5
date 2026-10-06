import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Redaction = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  reason: string;
  privilege: string;
  status: 'draft' | 'confirmed';
};

export type ReviewConclusion = {
  id: string;
  reviewerId: string;
  reviewerName: string;
  decision: 'approve' | 'reject';
  note: string;
  submittedAt: string;
  baseVersion: number;
};

export type ReleaseSnapshot = {
  id: string;
  documentId: string;
  version: number;
  regionsFingerprint: string;
  checksFingerprint: string;
  metadataCleaned: boolean;
  createdAt: string;
  createdBy: string;
  status: 'valid' | 'stale';
};

export type VersionLock = {
  version: number;
  lockedBy: string;
  lockedByName: string;
  lockedAt: string;
};

export type ProcessingRecord = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
};

export type DisclosureRecord = {
  id: string;
  title: string;
  bundle: string;
  pages: number;
  classification: '内部' | '机密' | '严格机密';
  owner: string;
  updatedAt: string;
  status: '去密中' | '待质检' | '可发布';
  issue: string;
  size: string;
  redactions: Redaction[];
  version: number;
  reviewChecks: Record<string, boolean>;
  metadataCleaned: boolean;
  reviewConclusions: ReviewConclusion[];
  snapshot: ReleaseSnapshot | null;
  lock: VersionLock | null;
  processingRecords: ProcessingRecord[];
};

export const REVIEWERS = [
  { id: 'A', name: '林清', role: '复核员 A' },
  { id: 'B', name: '周叙', role: '复核员 B' }
] as const;

export const defaultReviewChecks: Record<string, boolean> = {
  'forbidden-terms': true,
  'page-number': true,
  'image-boundary': false,
  'metadata': false
};

const now = () => new Date().toISOString();

/** Stable fingerprint of the redaction set — used to detect region drift. */
const fingerprintRegions = (redactions: Redaction[]): string => {
  const normalized = redactions
    .map((r) => `${r.page}:${r.x}:${r.y}:${r.width}:${r.height}:${r.status}`)
    .sort()
    .join('|');
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `r${(hash >>> 0).toString(36)}`;
};

/** Stable fingerprint of the review-check set — used to detect check drift. */
const fingerprintChecks = (checks: Record<string, boolean>): string => {
  const keys = Object.keys(checks).sort();
  const normalized = keys.map((k) => `${k}=${checks[k] ? 1 : 0}`).join('|');
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `c${(hash >>> 0).toString(36)}`;
};

/**
 * Bump the document version.
 *
 * Every content change (region / check / metadata) goes through this single
 * choke point so that the version, the lock and the snapshot always agree:
 *   - version increments
 *   - any held lock is released (it guarded the old version)
 *   - the current snapshot is marked stale (its version no longer matches)
 *   - a processing record is appended for audit
 */
const bumpVersion = (
  doc: DisclosureRecord,
  actor: string,
  action: string,
  detail: string
): DisclosureRecord => {
  const version = doc.version + 1;
  return {
    ...doc,
    version,
    lock: null,
    snapshot: doc.snapshot ? { ...doc.snapshot, status: 'stale' as const } : null,
    processingRecords: [
      ...doc.processingRecords,
      {
        id: `PR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: now(),
        actor,
        action,
        detail: `${detail}（v${doc.version} → v${version}）`
      }
    ]
  };
};

const defaultDocuments: DisclosureRecord[] = [
  {
    id: 'DOC-00418',
    title: '设备采购补充协议（第三版）',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '严格机密',
    owner: '林清',
    updatedAt: '09:48',
    status: '去密中',
    issue: '合同主体与商业条款',
    size: '8.4 MB',
    redactions: [
      { id: 'R-01', page: 1, x: 0.12, y: 0.16, width: 0.30, height: 0.04, reason: '商业秘密', privilege: '合同保密', status: 'confirmed' },
      { id: 'R-02', page: 1, x: 0.50, y: 0.43, width: 0.34, height: 0.06, reason: '个人手机号', privilege: '个人信息', status: 'draft' },
      { id: 'R-03', page: 2, x: 0.11, y: 0.25, width: 0.68, height: 0.05, reason: '第三方报价', privilege: '商业敏感', status: 'confirmed' }
    ],
    version: 1,
    reviewChecks: { ...defaultReviewChecks },
    metadataCleaned: false,
    reviewConclusions: [],
    snapshot: null,
    lock: null,
    processingRecords: [
      { id: 'PR-001', at: '2026-08-19T09:00:00', actor: '林清', action: '创建草稿', detail: '文档导入，开始去密区域绘制（v1）' },
      { id: 'PR-002', at: '2026-08-19T09:48:00', actor: '林清', action: '确认去密区域', detail: '确认区域 R-01（v1）' }
    ]
  },
  {
    id: 'DOC-00427',
    title: '现场会议纪要 2026-08-19',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '机密',
    owner: '周叙',
    updatedAt: '09:31',
    status: '待质检',
    issue: '事故预防与整改安排',
    size: '3.1 MB',
    redactions: [
      { id: 'R-04', page: 1, x: 0.08, y: 0.69, width: 0.74, height: 0.05, reason: '内部调查意见', privilege: '工作成果', status: 'confirmed' }
    ],
    version: 2,
    reviewChecks: { ...defaultReviewChecks, 'forbidden-terms': true, 'page-number': true },
    metadataCleaned: false,
    reviewConclusions: [],
    snapshot: null,
    lock: null,
    processingRecords: [
      { id: 'PR-003', at: '2026-08-19T08:30:00', actor: '周叙', action: '创建草稿', detail: '文档导入并完成去密区域绘制（v1）' },
      { id: 'PR-004', at: '2026-08-19T09:31:00', actor: '周叙', action: '提交质检', detail: '去密完成，提交双人复核（v2）' }
    ]
  },
  {
    id: 'DOC-00435',
    title: '设备运行数据摘录',
    bundle: '北岭项目 · 第二批披露',
    pages: 3,
    classification: '内部',
    owner: '顾言',
    updatedAt: '08:56',
    status: '可发布',
    issue: '运行记录',
    size: '12.7 MB',
    redactions: [
      { id: 'R-05', page: 2, x: 0.44, y: 0.56, width: 0.26, height: 0.04, reason: '人员姓名', privilege: '个人信息', status: 'confirmed' }
    ],
    version: 3,
    reviewChecks: {
      'forbidden-terms': true,
      'page-number': true,
      'image-boundary': true,
      'metadata': true
    },
    metadataCleaned: true,
    reviewConclusions: [
      { id: 'RC-001', reviewerId: 'A', reviewerName: '林清', decision: 'approve', note: '区域与原文一致，同意发布。', submittedAt: '2026-08-19T08:50:00', baseVersion: 3 },
      { id: 'RC-002', reviewerId: 'B', reviewerName: '周叙', decision: 'approve', note: '复核通过。', submittedAt: '2026-08-19T08:52:00', baseVersion: 3 }
    ],
    snapshot: {
      id: 'SNAP-DOC-00435-v3',
      documentId: 'DOC-00435',
      version: 3,
      regionsFingerprint: fingerprintRegions([
        { id: 'R-05', page: 2, x: 0.44, y: 0.56, width: 0.26, height: 0.04, reason: '人员姓名', privilege: '个人信息', status: 'confirmed' }
      ]),
      checksFingerprint: fingerprintChecks({
        'forbidden-terms': true,
        'page-number': true,
        'image-boundary': true,
        'metadata': true
      }),
      metadataCleaned: true,
      createdAt: '2026-08-19T08:55:00',
      createdBy: '复核员',
      status: 'valid'
    },
    lock: { version: 3, lockedBy: 'A', lockedByName: '林清', lockedAt: '2026-08-19T08:50:00' },
    processingRecords: [
      { id: 'PR-005', at: '2026-08-19T08:56:00', actor: '系统', action: '标记可发布', detail: '双人复核通过，快照有效（v3）' }
    ]
  }
];

export type SubmitResult =
  | { ok: true }
  | {
      ok: false;
      error: 'not-found' | 'version-conflict' | 'locked';
      message: string;
      currentVersion?: number;
      baseVersion?: number;
      lock?: VersionLock;
    };

export type SnapshotResult =
  | { ok: true; snapshot: ReleaseSnapshot; duplicated: boolean }
  | { ok: false; error: 'not-found' | 'write-failed'; message: string; retryable: boolean };

type State = {
  documents: DisclosureRecord[];
  activeDocumentId: string;
  activePage: number;
  activeRedactionId: string | null;
  redactionMode: boolean;
  snapshotWriteAttempts: Record<string, number>;
  selectDocument: (id: string) => void;
  setPage: (page: number) => void;
  toggleRedactionMode: () => void;
  addRedaction: (redaction: Omit<Redaction, 'id' | 'status'>) => void;
  confirmRedaction: (id: string) => void;
  selectRedaction: (id: string) => void;
  updateClassification: (classification: DisclosureRecord['classification']) => void;
  toggleReviewCheck: (documentId: string, id: string) => void;
  toggleMetadata: (documentId: string) => void;
  submitReviewConclusion: (
    documentId: string,
    reviewerId: string,
    decision: 'approve' | 'reject',
    note: string,
    baseVersion: number
  ) => SubmitResult;
  createSnapshot: (documentId: string) => SnapshotResult;
  retrySnapshot: (documentId: string) => SnapshotResult;
  markReady: (documentId: string) => void;
};

/**
 * Migrate a persisted document from an older draft shape.
 *
 * Guarantees: original regions, review checks and processing records are
 * preserved in full; only the new version-control fields are added.
 */
const migrateDocument = (doc: Record<string, unknown>): DisclosureRecord => {
  const version = (doc.version as number) ?? 1;
  return {
    ...(doc as DisclosureRecord),
    version,
    reviewChecks: (doc.reviewChecks as Record<string, boolean>) ?? { ...defaultReviewChecks },
    metadataCleaned: (doc.metadataCleaned as boolean) ?? false,
    reviewConclusions: (doc.reviewConclusions as ReviewConclusion[]) ?? [],
    snapshot: (doc.snapshot as ReleaseSnapshot) ?? null,
    lock: (doc.lock as VersionLock) ?? null,
    processingRecords: (doc.processingRecords as ProcessingRecord[]) ?? [
      {
        id: 'PR-MIGRATE',
        at: now(),
        actor: (doc.owner as string) ?? '系统',
        action: '升级草稿',
        detail: `旧草稿升级至版本 v${version}，保留原区域、勾选与处理记录`
      }
    ]
  };
};

export const useDisclosureStore = create<State>()(
  persist(
    (set, get) => ({
      documents: defaultDocuments,
      activeDocumentId: defaultDocuments[0].id,
      activePage: 1,
      activeRedactionId: 'R-02',
      redactionMode: false,
      snapshotWriteAttempts: {},
      selectDocument: (id) => set({ activeDocumentId: id, activePage: 1, activeRedactionId: null, redactionMode: false }),
      setPage: (page) => set({ activePage: page }),
      toggleRedactionMode: () => set((state) => ({ redactionMode: !state.redactionMode })),
      addRedaction: (redaction) =>
        set((state) => ({
          documents: state.documents.map((doc) => {
            if (doc.id !== state.activeDocumentId) return doc;
            const next = bumpVersion(
              {
                ...doc,
                redactions: [...doc.redactions, { ...redaction, id: `R-${Date.now()}`, status: 'draft' as const }]
              },
              doc.owner,
              '添加去密区域',
              `在第 ${redaction.page} 页绘制新区域，区域集合变更`
            );
            return next;
          })
        })),
      confirmRedaction: (id) =>
        set((state) => ({
          documents: state.documents.map((doc) => {
            if (doc.id !== state.activeDocumentId) return doc;
            const target = doc.redactions.find((r) => r.id === id);
            const next = bumpVersion(
              {
                ...doc,
                redactions: doc.redactions.map((r) => (r.id === id ? { ...r, status: 'confirmed' as const } : r))
              },
              doc.owner,
              '确认去密区域',
              `确认区域 ${target?.id ?? id}，快照失效，需重新对照`
            );
            return next;
          })
        })),
      selectRedaction: (id) => set({ activeRedactionId: id }),
      updateClassification: (classification) =>
        set((state) => ({
          documents: state.documents.map((doc) =>
            doc.id === state.activeDocumentId ? { ...doc, classification } : doc
          )
        })),
      toggleReviewCheck: (documentId, id) =>
        set((state) => ({
          documents: state.documents.map((doc) => {
            if (doc.id !== documentId) return doc;
            const next = bumpVersion(
              { ...doc, reviewChecks: { ...doc.reviewChecks, [id]: !doc.reviewChecks[id] } },
              '复核员',
              '切换复核项',
              `复核项「${id}」变更，快照失效，需重新对照`
            );
            return next;
          })
        })),
      toggleMetadata: (documentId) =>
        set((state) => ({
          documents: state.documents.map((doc) => {
            if (doc.id !== documentId) return doc;
            const next = bumpVersion(
              { ...doc, metadataCleaned: !doc.metadataCleaned },
              '复核员',
              '切换元数据清理确认',
              '元数据清理确认变更，快照失效，需重新对照'
            );
            return next;
          })
        })),
      submitReviewConclusion: (documentId, reviewerId, decision, note, baseVersion) => {
        const doc = get().documents.find((d) => d.id === documentId);
        if (!doc) {
          return { ok: false, error: 'not-found', message: '文档不存在，无法提交复核结论。' };
        }
        const reviewer = REVIEWERS.find((r) => r.id === reviewerId);
        const reviewerName = reviewer?.name ?? reviewerId;

        // 1) Version conflict: the document moved on since the reviewer based
        //    their conclusion on it (region / check / metadata changed).
        if (doc.version !== baseVersion) {
          return {
            ok: false,
            error: 'version-conflict',
            message: `文档版本已从 v${baseVersion} 升至 v${doc.version}，您的结论基于旧版本，请重新对照后再提交。`,
            currentVersion: doc.version,
            baseVersion
          };
        }

        // 2) Lock conflict: another reviewer was first to submit on this version.
        if (doc.lock && doc.lock.lockedBy !== reviewerId) {
          return {
            ok: false,
            error: 'locked',
            message: `版本 v${doc.version} 已被 ${doc.lock.lockedByName} 锁定，先到者已提交结论。您的意见已保留，可待版本更新后重新提交。`,
            lock: doc.lock
          };
        }

        // 3) Accept: lock the version and record the conclusion.
        //    A reviewer may update their own conclusion on the same version.
        const conclusion: ReviewConclusion = {
          id: `RC-${Date.now()}`,
          reviewerId,
          reviewerName,
          decision,
          note,
          submittedAt: now(),
          baseVersion
        };
        set((state) => ({
          documents: state.documents.map((d) =>
            d.id === documentId
              ? {
                  ...d,
                  lock: {
                    version: d.version,
                    lockedBy: reviewerId,
                    lockedByName: reviewerName,
                    lockedAt: now()
                  },
                  reviewConclusions: [
                    ...d.reviewConclusions.filter((c) => c.reviewerId !== reviewerId),
                    conclusion
                  ],
                  processingRecords: [
                    ...d.processingRecords,
                    {
                      id: `PR-${Date.now()}`,
                      at: now(),
                      actor: reviewerName,
                      action: '提交复核结论',
                      detail: `结论：${decision === 'approve' ? '通过' : '退回'}，基于 v${baseVersion}，锁定该版本`
                    }
                  ]
                }
              : d
          )
        }));
        return { ok: true };
      },
      createSnapshot: (documentId) => {
        const state = get();
        const doc = state.documents.find((d) => d.id === documentId);
        if (!doc) {
          return { ok: false, error: 'not-found', message: '文档不存在，无法创建快照。', retryable: false };
        }

        // Idempotency: a valid snapshot for the current version already exists —
        // return it instead of writing a duplicate.
        if (doc.snapshot && doc.snapshot.status === 'valid' && doc.snapshot.version === doc.version) {
          return { ok: true, snapshot: doc.snapshot, duplicated: false };
        }

        // Simulated write failure: the first write attempt for a document fails.
        // Retrying by document id must recover without leaving duplicate snapshots.
        const attempts = state.snapshotWriteAttempts[documentId] ?? 0;
        if (attempts === 0) {
          set((s) => ({
            snapshotWriteAttempts: { ...s.snapshotWriteAttempts, [documentId]: 1 }
          }));
          return {
            ok: false,
            error: 'write-failed',
            message: '快照写入失败（模拟）。请按文档编号重试恢复，系统不会重复写入快照。',
            retryable: true
          };
        }

        const snapshot: ReleaseSnapshot = {
          id: `SNAP-${documentId}-v${doc.version}`,
          documentId,
          version: doc.version,
          regionsFingerprint: fingerprintRegions(doc.redactions),
          checksFingerprint: fingerprintChecks(doc.reviewChecks),
          metadataCleaned: doc.metadataCleaned,
          createdAt: now(),
          createdBy: '复核员',
          status: 'valid'
        };
        set((s) => ({
          documents: s.documents.map((d) =>
            d.id === documentId
              ? {
                  ...d,
                  snapshot,
                  processingRecords: [
                    ...d.processingRecords,
                    {
                      id: `PR-${Date.now()}`,
                      at: now(),
                      actor: '复核员',
                      action: '创建发布快照',
                      detail: `快照 ${snapshot.id} 写入成功，版本 v${doc.version}`
                    }
                  ]
                }
              : d
          )
        }));
        return { ok: true, snapshot, duplicated: false };
      },
      retrySnapshot: (documentId) => {
        // Retry recovery by document id. createSnapshot is idempotent: if a
        // valid snapshot for this version already exists it is returned, so a
        // retry can never leave a duplicate snapshot.
        return get().createSnapshot(documentId);
      },
      markReady: (documentId) =>
        set((state) => ({
          documents: state.documents.map((doc) =>
            doc.id === documentId ? { ...doc, status: '可发布' as const } : doc
          )
        }))
    }),
    {
      name: 'yy59-disclosure-draft',
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        if (version >= 2 || !persistedState) return persistedState as State;
        const legacy = persistedState as Record<string, unknown>;
        const { documents, reviewChecks, metadataCleaned, snapshotWriteAttempts, ...rest } = legacy;
        return {
          ...rest,
          documents: (documents as Record<string, unknown>[] | undefined)?.map(migrateDocument) ?? defaultDocuments,
          snapshotWriteAttempts: (snapshotWriteAttempts as Record<string, number>) ?? {}
        } as State;
      }
    }
  )
);
