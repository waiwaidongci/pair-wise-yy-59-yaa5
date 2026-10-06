// 发布质控版本模型：去密区域、复核项与发布快照共用同一个 contentVersion。
// 所有版本判断均为纯函数，store 只负责调度与持久化。

export type ReviewerId = 'shen' | 'lu';

export const REVIEWERS: { id: ReviewerId; name: string; role: string }[] = [
  { id: 'shen', name: '沈纹', role: '初审复核员' },
  { id: 'lu', name: '陆铮', role: '复审复核员' }
];

export type CheckId = 'forbidden-terms' | 'page-number' | 'image-boundary' | 'metadata';

export const REVIEW_CHECKS: { id: CheckId; label: string; detail: string }[] = [
  { id: 'forbidden-terms', label: '全文禁词与姓名复核', detail: '扫描原始页和发布页文本层' },
  { id: 'page-number', label: '页序与页码连续性', detail: '检查拆页、合并及漏页情况' },
  { id: 'image-boundary', label: '图像边界残片', detail: '逐页比较遮蔽边界 2mm 区域' },
  { id: 'metadata', label: '文档元数据清理', detail: '作者、修订人、批注和隐藏字段' }
];

export const CHECK_IDS = REVIEW_CHECKS.map((item) => item.id);

export const checkLabel = (id: CheckId) => REVIEW_CHECKS.find((item) => item.id === id)?.label ?? id;

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

export type HistoryKind =
  | 'region'
  | 'check'
  | 'snapshot'
  | 'submit'
  | 'conflict'
  | 'release'
  | 'upgrade'
  | 'recovery'
  | 'compare'
  | 'draft'
  | 'system';

export type ProcessRecord = {
  id: string;
  at: string;
  actor: string;
  kind: HistoryKind;
  version: number;
  text: string;
};

export type ReviewConclusion = {
  reviewerId: ReviewerId;
  decision: 'approve' | 'return';
  at: string;
  version: number;
  checkFingerprint: string;
};

export type ReleaseSnapshot = {
  id: string;
  version: number;
  fingerprint: string;
  createdAt: string;
  createdBy: ReviewerId;
  /** 幂等键：文档编号 + 版本 + 指纹，重试恢复时快照只落一份 */
  idemKey: string;
};

export type ReviewLock = {
  version: number;
  by: ReviewerId;
  at: string;
};

/** 复核员各自打开的工作稿：提交时与权威版本做乐观并发比对 */
export type WorkingCopy = {
  id: string;
  reviewerId: ReviewerId;
  openedAt: string;
  basedOnVersion: number;
  observedLock: ReviewLock | null;
  /** 打开工作稿时版本是否已被先到者锁定（用于识别“两人同时打开、先到者后提交”的竞争） */
  lockSeenAtOpen: boolean;
  checks: Record<CheckId, boolean>;
  metadataAck: boolean;
  comparedVersion: number | null;
  decision: 'approve' | 'return' | null;
};

export type ConflictReason = 'locked-by-other' | 'version-moved' | 'duplicate';

/** 后到者的冲突现场：工作稿原样保留，不覆盖、不丢弃 */
export type ReviewConflict = {
  id: string;
  reviewerId: ReviewerId;
  at: string;
  reason: ConflictReason;
  submittedVersion: number;
  currentVersion: number;
  lock: ReviewLock | null;
  workingCopy: WorkingCopy;
  text: string;
};

export type ReviewState = {
  contentVersion: number;
  checks: Record<CheckId, boolean>;
  metadataCleaned: boolean;
  snapshot: ReleaseSnapshot | null;
  lock: ReviewLock | null;
  conclusions: ReviewConclusion[];
  workingCopies: WorkingCopy[];
  conflict: ReviewConflict | null;
  /** reviewerId -> 已逐页重新对照确认的版本号 */
  comparedBy: Partial<Record<ReviewerId, number>>;
  history: ProcessRecord[];
  /** 旧草稿升级标记；写入失败时挂起，按文档编号重试 */
  pendingUpgrade?: boolean;
  upgradeAttempts?: number;
  upgradedAt?: string;
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
  review: ReviewState;
};

// ---------- 纯工具 ----------

let seq = 0;
export const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 当前权威内容指纹：去密区域 + 复核项勾选 + 元数据确认 */
export function contentFingerprint(
  doc: Pick<DisclosureRecord, 'redactions'>,
  review: Pick<ReviewState, 'checks' | 'metadataCleaned'>
): string {
  const regions = doc.redactions
    .map((r) => `${r.id}:${r.page},${r.x},${r.y},${r.width},${r.height},${r.reason},${r.privilege},${r.status}`)
    .join('|');
  const checks = CHECK_IDS.map((id) => `${id}=${review.checks[id] ? 1 : 0}`).join(',');
  return fnv1a(`R[${regions}]|${checks}|meta=${review.metadataCleaned ? 1 : 0}`);
}

export const snapshotIdemKey = (docId: string, review: Pick<ReviewState, 'contentVersion' | 'checks' | 'metadataCleaned'>, doc: Pick<DisclosureRecord, 'redactions'>) =>
  `snap-${docId}-v${review.contentVersion}-${contentFingerprint(doc, review)}`;

export function isSnapshotFresh(doc: DisclosureRecord): boolean {
  const { review } = doc;
  return !!review.snapshot
    && review.snapshot.version === review.contentVersion
    && review.snapshot.fingerprint === contentFingerprint(doc, review);
}

export function pushHistory(
  review: ReviewState,
  rec: Omit<ProcessRecord, 'id' | 'at'> & { id?: string; at?: string }
): ReviewState {
  if (rec.id && review.history.some((item) => item.id === rec.id)) return review;
  const record: ProcessRecord = { id: rec.id ?? nextId('rec'), at: rec.at ?? stamp(), ...rec };
  return { ...review, history: [record, ...review.history] };
}

export type GateState = { ready: boolean; reasons: string[] };

/** 发布门禁：快照、复核项、双人当前版本结论、重新对照、无未决冲突，缺一不可 */
export function approvalGate(doc: DisclosureRecord): GateState {
  const review = doc.review;
  const reasons: string[] = [];
  if (!review.snapshot) reasons.push('尚无发布快照，需先对照原页与发布页并生成快照');
  else if (!isSnapshotFresh(doc)) {
    reasons.push(`发布快照基于 v${review.snapshot.version}，当前为 v${review.contentVersion}，快照已失效，需重新对照并生成`);
  }
  const missing = REVIEW_CHECKS.filter((item) => !review.checks[item.id]);
  if (missing.length > 0) reasons.push(`复核项未全部通过：${missing.map((item) => item.label).join('、')}`);
  if (!review.metadataCleaned) reasons.push('尚未确认文档元数据已清理');
  if (review.conflict) reasons.push(`存在未处理的复核冲突（${REVIEWERS.find((r) => r.id === review.conflict!.reviewerId)?.name} 的现场已保留）`);
  for (const reviewer of REVIEWERS) {
    const conclusion = review.conclusions.find((c) => c.reviewerId === reviewer.id && c.version === review.contentVersion);
    if (!conclusion) reasons.push(`${reviewer.name}（${reviewer.role}）尚未在 v${review.contentVersion} 提交复核结论`);
    else if (conclusion.decision !== 'approve') reasons.push(`${reviewer.name} 在本版本的结论为“退回补件”`);
    if (review.comparedBy[reviewer.id] !== review.contentVersion) {
      reasons.push(`${reviewer.name} 尚未在 v${review.contentVersion} 逐页重新对照原页与发布页`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

// ---------- 构造与迁移 ----------

export function normalizeChecks(input?: Partial<Record<CheckId, boolean>> | Record<string, boolean> | null): Record<CheckId, boolean> {
  return {
    'forbidden-terms': input?.['forbidden-terms'] ?? false,
    'page-number': input?.['page-number'] ?? false,
    'image-boundary': input?.['image-boundary'] ?? false,
    metadata: input?.metadata ?? false
  };
}

type BuildReviewInput = {
  version: number;
  checks?: Record<CheckId, boolean>;
  metadataCleaned?: boolean;
  snapshot?: ReleaseSnapshot | null;
  lock?: ReviewLock | null;
  conclusions?: ReviewConclusion[];
  workingCopies?: WorkingCopy[];
  comparedBy?: Partial<Record<ReviewerId, number>>;
  history?: ProcessRecord[];
};

export function buildReview(input: BuildReviewInput): ReviewState {
  return {
    contentVersion: input.version,
    checks: input.checks ?? normalizeChecks(),
    metadataCleaned: input.metadataCleaned ?? false,
    snapshot: input.snapshot ?? null,
    lock: input.lock ?? null,
    conclusions: input.conclusions ?? [],
    workingCopies: input.workingCopies ?? [],
    conflict: null,
    comparedBy: input.comparedBy ?? {},
    history: input.history ?? []
  };
}

/**
 * 旧草稿升级：原区域、勾选与处理记录全部保留，版本从 v1 重新计数。
 * 升级写入先挂起（pendingUpgrade），由恢复流程按文档编号幂等完成。
 */
export function upgradeLegacyReview(
  doc: { id: string; redactions: Redaction[] },
  legacy?: { checks?: Record<string, boolean> | null; metadataCleaned?: boolean; history?: ProcessRecord[] }
): ReviewState {
  return {
    contentVersion: 1,
    checks: normalizeChecks(legacy?.checks),
    metadataCleaned: legacy?.metadataCleaned ?? false,
    snapshot: null,
    lock: null,
    conclusions: [],
    workingCopies: [],
    conflict: null,
    comparedBy: {},
    history: [...(legacy?.history ?? [])],
    pendingUpgrade: true,
    upgradeAttempts: 0,
    upgradedAt: stamp()
  };
}

// ---------- 初始示例数据 ----------

const baseRedactions = {
  'DOC-00418': [
    { id: 'R-01', page: 1, x: 0.12, y: 0.16, width: 0.3, height: 0.04, reason: '商业秘密', privilege: '合同保密', status: 'confirmed' },
    { id: 'R-02', page: 1, x: 0.5, y: 0.43, width: 0.34, height: 0.06, reason: '个人手机号', privilege: '个人信息', status: 'draft' },
    { id: 'R-03', page: 2, x: 0.11, y: 0.25, width: 0.68, height: 0.05, reason: '第三方报价', privilege: '商业敏感', status: 'confirmed' }
  ] as Redaction[],
  'DOC-00427': [
    { id: 'R-04', page: 1, x: 0.08, y: 0.69, width: 0.74, height: 0.05, reason: '内部调查意见', privilege: '工作成果', status: 'confirmed' }
  ] as Redaction[],
  'DOC-00435': [
    { id: 'R-05', page: 2, x: 0.44, y: 0.56, width: 0.26, height: 0.04, reason: '人员姓名', privilege: '个人信息', status: 'confirmed' }
  ] as Redaction[]
};

function docShell(id: string, patch: Partial<DisclosureRecord> & Pick<DisclosureRecord, 'title' | 'bundle' | 'pages' | 'classification' | 'owner' | 'updatedAt' | 'status' | 'issue' | 'size'>): DisclosureRecord {
  return { redactions: baseRedactions[id as keyof typeof baseRedactions] ?? [], review: buildReview({ version: 1 }), ...patch, id };
}

export function createDefaultDocuments(): DisclosureRecord[] {
  const doc418 = docShell('DOC-00418', {
    title: '设备采购补充协议（第三版）',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '严格机密',
    owner: '林清',
    updatedAt: '09:48',
    status: '去密中',
    issue: '合同主体与商业条款',
    size: '8.4 MB'
  });
  doc418.review = buildReview({
    version: 2,
    history: [
      { id: 'rec-seed-418-2', at: '09:48:02', actor: '林清', kind: 'region', version: 2, text: '确认合同价款遮蔽区域 R-01，版本提升至 v2' },
      { id: 'rec-seed-418-1', at: '09:12:35', actor: '林清', kind: 'region', version: 1, text: '绘制草稿区域 R-02（个人手机号）' }
    ]
  });

  const doc427 = docShell('DOC-00427', {
    title: '现场会议纪要 2026-08-19',
    bundle: '北岭项目 · 第一批披露',
    pages: 3,
    classification: '机密',
    owner: '周叙',
    updatedAt: '09:31',
    status: '待质检',
    issue: '事故预防与整改安排',
    size: '3.1 MB'
  });
  doc427.review = buildReview({
    version: 3,
    checks: normalizeChecks({ 'forbidden-terms': true, 'page-number': true }),
    history: [
      { id: 'rec-seed-427-3', at: '09:31:12', actor: '沈纹', kind: 'submit', version: 3, text: '初审结论：通过；先到锁定 v3，等待复审提交' },
      { id: 'rec-seed-427-2', at: '09:29:40', actor: '周叙', kind: 'region', version: 3, text: '确认遮蔽区域 R-04（内部调查意见），版本提升至 v3' },
      { id: 'rec-seed-427-1', at: '09:30:00', actor: '周叙', kind: 'system', version: 2, text: '提交质检，进入双人复核' }
    ],
    lock: { version: 3, by: 'shen', at: '09:31:12' },
    conclusions: [{ reviewerId: 'shen', decision: 'approve', at: '09:31:12', version: 3, checkFingerprint: '' }]
  });
  doc427.review.conclusions[0].checkFingerprint = contentFingerprint(doc427, doc427.review);

  const doc435 = docShell('DOC-00435', {
    title: '设备运行数据摘录',
    bundle: '北岭项目 · 第二批披露',
    pages: 3,
    classification: '内部',
    owner: '顾言',
    updatedAt: '08:56',
    status: '可发布',
    issue: '运行记录',
    size: '12.7 MB'
  });
  doc435.review = buildReview({
    version: 2,
    checks: normalizeChecks({ 'forbidden-terms': true, 'page-number': true, 'image-boundary': true, metadata: true }),
    metadataCleaned: true,
    comparedBy: { shen: 2, lu: 2 },
    history: [
      { id: 'rec-seed-435-4', at: '08:54:18', actor: '陆铮', kind: 'release', version: 2, text: '双人复核通过，批准发布 v2 快照' },
      { id: 'rec-seed-435-3', at: '08:49:52', actor: '陆铮', kind: 'submit', version: 2, text: '复审结论：通过' },
      { id: 'rec-seed-435-2', at: '08:46:30', actor: '沈纹', kind: 'submit', version: 2, text: '初审结论：通过；先到锁定 v2' },
      { id: 'rec-seed-435-1', at: '08:41:09', actor: '沈纹', kind: 'snapshot', version: 2, text: '原页/发布页对照完成，生成 v2 发布快照' }
    ],
    lock: { version: 2, by: 'shen', at: '08:46:30' },
    conclusions: [
      { reviewerId: 'shen', decision: 'approve', at: '08:46:30', version: 2, checkFingerprint: '' },
      { reviewerId: 'lu', decision: 'approve', at: '08:49:52', version: 2, checkFingerprint: '' }
    ]
  });
  const fp435 = contentFingerprint(doc435, doc435.review);
  doc435.review.conclusions[0].checkFingerprint = fp435;
  doc435.review.conclusions[1].checkFingerprint = fp435;
  doc435.review.snapshot = {
    id: 'snap-seed-435',
    version: 2,
    fingerprint: fp435,
    createdAt: '08:41:09',
    createdBy: 'shen',
    idemKey: snapshotIdemKey('DOC-00435', doc435.review, doc435)
  };

  return [doc418, doc427, doc435];
}
