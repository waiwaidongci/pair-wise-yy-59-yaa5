import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams
} from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Eye,
  FileCheck2,
  FileText,
  GitCompareArrows,
  History as HistoryIcon,
  Highlighter,
  Layers3,
  Lock,
  Menu,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Stamp,
  Tags,
  UploadCloud,
  Users,
  X,
  Zap
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Badge, Button, Card, Dialog, Tabs } from './components/ui';
import {
  REVIEW_CHECKS,
  REVIEWERS,
  approvalGate,
  isSnapshotFresh,
  type DisclosureRecord,
  type HistoryKind,
  type ProcessRecord,
  type ReviewerId
} from './reviewModel';
import { useDisclosureStore } from './store';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const bundleQuery = async () => ({
  queue: [
    { id: 'Q-31', name: '第三批补充材料', count: 128, owner: '林清', progress: 68, due: '今日 16:00' },
    { id: 'Q-32', name: '证人材料图像件', count: 47, owner: '周叙', progress: 34, due: '明日 11:00' },
    { id: 'Q-33', name: '专家报告附件', count: 19, owner: '顾言', progress: 91, due: '09-30 18:00' }
  ]
});

const historyIcon: Record<HistoryKind, typeof FileText> = {
  region: Highlighter,
  check: ClipboardCheck,
  snapshot: GitCompareArrows,
  submit: FileCheck2,
  conflict: AlertTriangle,
  release: ShieldCheck,
  upgrade: Zap,
  recovery: RefreshCw,
  compare: Eye,
  draft: Users,
  system: Stamp
};

function AppShell() {
  const [mobileNav, setMobileNav] = useState(false);
  const recoverPendingUpgrades = useDisclosureStore((state) => state.recoverPendingUpgrades);
  useEffect(() => {
    // 启动时恢复写入失败后挂起的旧草稿升级（幂等，重复调用安全）
    recoverPendingUpgrades();
  }, [recoverPendingUpgrades]);
  const links = [
    { to: '/', label: '文档集', icon: Layers3 },
    { to: '/review/$documentId', label: '去密审阅', icon: Highlighter },
    { to: '/quality', label: '发布质检', icon: ScanSearch },
    { to: '/batches', label: '批次与标签', icon: Tags }
  ];
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-symbol"><Stamp size={18} /></div>
          <div><strong>披露质控台</strong><span>North Ridge / Litigation Support</span></div>
        </div>
        <div className="top-actions">
          <Badge tone="amber">2 项待质检</Badge>
          <div className="operator"><span>质控员</span><strong>林清 · 审核组</strong></div>
        </div>
        <button className="mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="菜单"><Menu /></button>
      </header>
      <div className="shell-body">
        <aside className={mobileNav ? 'sidebar open' : 'sidebar'}>
          <div className="workspace-title">
            <span>当前工作区</span>
            <strong>北岭项目 · 诉讼披露</strong>
          </div>
          <nav>
            {links.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to as '/'} activeProps={{ className: 'active' }} params={to.includes('$documentId') ? { documentId: 'DOC-00418' } : undefined} onClick={() => setMobileNav(false)}>
                <Icon size={17} /> <span>{label}</span>
              </Link>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div><ShieldCheck size={16} /><span>审计记录已开启</span></div>
            <small>草稿自动保存在本机 · 区域/复核项/快照共用内容版本</small>
          </div>
        </aside>
        <main className="main-content"><Outlet /></main>
      </div>
    </div>
  );
}

function DocumentsPage() {
  const documents = useDisclosureStore((state) => state.documents);
  const setQualityDocument = useDisclosureStore((state) => state.setQualityDocument);
  const { data } = useQuery({ queryKey: ['document-queues'], queryFn: bundleQuery });
  const [filter, setFilter] = useState('全部');
  const visible = filter === '全部' ? documents : documents.filter((doc) => doc.status === filter);
  return (
    <div className="page">
      <header className="page-heading">
        <div><small>DISCLOSURE CONTROL / DOCUMENT SET</small><h1>披露文档集</h1><p>分批完成密级复核、敏感区域去密与发布版本比对。</p></div>
        <Button><UploadCloud size={16} /> 导入文档集</Button>
      </header>
      <section className="summary-strip">
        <div><span>文档总数</span><strong>194</strong><small>12.8 GB</small></div>
        <div><span>去密区域</span><strong>2,481</strong><small>较上版 +34</small></div>
        <div><span>待质检</span><strong className="warning-text">17</strong><small>4 项高风险</small></div>
        <div><span>已批准批次</span><strong>6</strong><small>本周 +2</small></div>
      </section>
      <div className="two-column">
        <Card className="document-table-card">
          <div className="card-heading">
            <div><Tabs.Root value={filter} onValueChange={setFilter}><Tabs.List className="segmented">
              {['全部', '去密中', '待质检', '可发布'].map((item) => <Tabs.Trigger key={item} value={item}>{item}</Tabs.Trigger>)}
            </Tabs.List></Tabs.Root></div>
            <span>{visible.length} 份文档</span>
          </div>
          <div className="document-table">
            {visible.map((doc) => {
              const fresh = isSnapshotFresh(doc);
              const locked = doc.review.lock?.version === doc.review.contentVersion;
              return (
                <div className="document-row" key={doc.id}>
                  <div className="file-icon"><FileText size={19} /></div>
                  <div className="doc-main">
                    <strong>{doc.title}</strong>
                    <span>{doc.id} · {doc.bundle} · {doc.size}</span>
                    <span className="version-line">
                      <i className={`version-dot ${fresh ? 'fresh' : doc.review.snapshot ? 'stale' : 'none'}`} />
                      内容版本 v{doc.review.contentVersion}
                      {locked && <em className="lock-mini"><Lock size={10} /> {REVIEWERS.find((r) => r.id === doc.review.lock?.by)?.name}已锁定</em>}
                      {doc.review.snapshot && <em className={fresh ? 'snap-mini ok' : 'snap-mini bad'}>{fresh ? `快照 v${doc.review.snapshot.version} 有效` : `快照 v${doc.review.snapshot.version} 已失效`}</em>}
                    </span>
                  </div>
                  <div className="doc-field"><span>密级</span><Badge tone={doc.classification === '严格机密' ? 'red' : doc.classification === '机密' ? 'amber' : 'neutral'}>{doc.classification}</Badge></div>
                  <div className="doc-field"><span>负责人员</span><strong>{doc.owner}</strong></div>
                  <div className="doc-field"><span>状态</span><Badge tone={doc.status === '可发布' ? 'green' : doc.status === '待质检' ? 'amber' : 'blue'}>{doc.status}</Badge></div>
                  <div className="doc-actions">
                    <Link to="/review/$documentId" params={{ documentId: doc.id }}><Button variant="outline">审阅</Button></Link>
                    {doc.status !== '去密中' && (
                      <Link to="/quality" onClick={() => setQualityDocument(doc.id)}><Button variant="ghost">质控</Button></Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
        <aside className="side-stack">
          <Card className="queue-card">
            <div className="card-title"><ClipboardCheck size={17} /><strong>去密任务队列</strong></div>
            {(data?.queue ?? []).map((item) => (
              <div className="queue-item" key={item.id}>
                <div><strong>{item.name}</strong><span>{item.count} 份 · {item.owner}</span></div>
                <div className="progress"><i style={{ width: `${item.progress}%` }} /></div>
                <small>{item.progress}% · 截止 {item.due}</small>
              </div>
            ))}
          </Card>
          <Card className="audit-card">
            <div className="card-title"><ShieldCheck size={17} /><strong>最近操作</strong></div>
            <p><b>09:48</b> 林清确认 DOC-00418 的合同价款遮蔽区域。</p>
            <p><b>09:31</b> 沈纹先到锁定 DOC-00427 v3，等待复审。</p>
            <p><b>08:54</b> 顾言导出 DOC-00435 发布清单。</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function useDemoPdf() {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    let alive = true;
    PDFDocument.create().then(async (pdf) => {
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (let pageNo = 1; pageNo <= 3; pageNo += 1) {
        const page = pdf.addPage([612, 792]);
        page.drawText(`NORTH RIDGE PROJECT - DISCLOSURE EXHIBIT`, { x: 54, y: 728, size: 14, font, color: rgb(0.12, 0.16, 0.2) });
        page.drawText(`Document page ${pageNo} / 3`, { x: 54, y: 704, size: 10, font, color: rgb(0.35, 0.39, 0.43) });
        page.drawLine({ start: { x: 54, y: 690 }, end: { x: 558, y: 690 }, thickness: 1, color: rgb(0.75, 0.78, 0.8) });
        const lines = [
          'Commercial terms and operational records',
          'Parties: North Ridge Equipment Co. and Haiyang Logistics',
          'Reference No. NR-2026-0819 / Confidentiality class: strictly confidential',
          '',
          'The supplier shall provide maintenance records, operating data and',
          'incident reports within ten business days after each quarterly review.',
          '',
          'Contact: [redacted personal information]',
          'Commercial consideration: [redacted third-party quotation]',
          '',
          'This copy is prepared solely for disclosure review. Every marked region',
          'must be confirmed against the original before approval and release.'
        ];
        lines.forEach((line, index) => page.drawText(line, { x: 54, y: 655 - index * 24, size: 10, font, color: rgb(0.1, 0.13, 0.16) }));
        page.drawText(`Control stamp: REVIEW-${String(pageNo).padStart(2, '0')}`, { x: 54, y: 72, size: 9, font, color: rgb(0.5, 0.53, 0.56) });
      }
      return pdf.save();
    }).then((data) => {
      if (alive) {
        const copy = new Uint8Array(data);
        setBytes(copy.buffer as ArrayBuffer);
      }
    });
    return () => { alive = false; };
  }, []);
  return bytes;
}

function PdfPage({ pageNumber, redacted = false, onDraw }: { pageNumber: number; redacted?: boolean; onDraw?: (region: { x: number; y: number; width: number; height: number }) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bytes = useDemoPdf();
  const [drawing, setDrawing] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const start = useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (!bytes || !canvasRef.current) return;
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    const render = async () => {
      task = pdfjs.getDocument({ data: bytes.slice(0) });
      const pdf = await task.promise;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.25 });
      const canvas = canvasRef.current!;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = viewport.width * ratio;
      canvas.height = viewport.height * ratio;
      canvas.style.width = '100%';
      canvas.style.aspectRatio = `${viewport.width}/${viewport.height}`;
      const context = canvas.getContext('2d')!;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
    };
    render().catch(console.error);
    return () => { task?.destroy(); };
  }, [bytes, pageNumber]);

  const pointerDown = (event: React.PointerEvent) => {
    if (!onDraw) return;
    const rect = event.currentTarget.getBoundingClientRect();
    start.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    setDrawing({ x: start.current.x / rect.width, y: start.current.y / rect.height, width: 0, height: 0 });
  };
  const pointerMove = (event: React.PointerEvent) => {
    if (!drawing || !onDraw) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(start.current.x, event.clientX - rect.left) / rect.width;
    const y = Math.min(start.current.y, event.clientY - rect.top) / rect.height;
    const width = Math.abs(event.clientX - rect.left - start.current.x) / rect.width;
    const height = Math.abs(event.clientY - rect.top - start.current.y) / rect.height;
    setDrawing({ x, y, width, height });
  };
  const pointerUp = () => {
    if (drawing && onDraw && drawing.width > 0.015 && drawing.height > 0.01) onDraw(drawing);
    setDrawing(null);
  };
  return (
    <div className={`pdf-page ${onDraw ? 'drawable' : ''}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}>
      <canvas ref={canvasRef} />
      {redacted && <div className="page-redaction-demo"><span>已发布区域掩码</span></div>}
      {drawing && <i className="drawing-region" style={{ left: `${drawing.x * 100}%`, top: `${drawing.y * 100}%`, width: `${drawing.width * 100}%`, height: `${drawing.height * 100}%` }} />}
    </div>
  );
}

function ReviewPage() {
  const { documentId } = useParams({ from: '/review/$documentId' });
  const navigate = useNavigate();
  const documents = useDisclosureStore((state) => state.documents);
  const { activePage, redactionMode, activeRedactionId } = useDisclosureStore();
  const store = useDisclosureStore();
  const doc = documents.find((item) => item.id === documentId) ?? documents[0];
  const pageRegions = doc.redactions.filter((item) => item.page === activePage);
  const active = doc.redactions.find((item) => item.id === activeRedactionId);
  const fresh = isSnapshotFresh(doc);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState('商业秘密');
  const [privilege, setPrivilege] = useState('合同保密');
  return (
    <div className="page review-page">
      <header className="review-header">
        <div className="review-title">
          <Button variant="ghost" onClick={() => navigate({ to: '/' })}><ArrowLeft size={16} /></Button>
          <div><small>{doc.id} / 去密审阅</small><h1>{doc.title}</h1></div>
          <Badge tone={doc.classification === '严格机密' ? 'red' : 'amber'}>{doc.classification}</Badge>
          <Badge tone="blue">内容版本 v{doc.review.contentVersion}</Badge>
          <Badge tone={fresh ? 'green' : doc.review.snapshot ? 'amber' : 'neutral'}>
            {fresh ? `发布快照 v${doc.review.snapshot?.version} 有效` : doc.review.snapshot ? `快照 v${doc.review.snapshot.version} 已失效` : '尚无发布快照'}
          </Badge>
        </div>
        <div className="review-actions">
          <Button variant="outline" onClick={() => store.toggleRedactionMode()} className={redactionMode ? 'active-button' : ''}><Highlighter size={16} /> {redactionMode ? '取消绘制' : '绘制去密区'}</Button>
          <Button variant="outline" onClick={() => setDialogOpen(true)}><FileCheck2 size={16} /> 发布前校验</Button>
          <Button onClick={() => {
            store.submitForQa();
            store.setQualityDocument(doc.id);
            navigate({ to: '/quality' });
          }}><Check size={16} /> 提交质检</Button>
        </div>
      </header>
      <div className="review-layout">
        <aside className="page-thumbs">
          <div className="side-label">页级预览 <span>{doc.pages} 页</span></div>
          {[1, 2, 3].map((page) => (
            <button key={page} className={activePage === page ? 'active' : ''} onClick={() => store.setPage(page)}>
              <div className="mini-page"><span>{page}</span><i style={{ width: `${45 + page * 9}%` }} /><i style={{ width: `${70 - page * 5}%` }} /><i style={{ width: `${55 + page * 4}%` }} /></div>
              <small>第 {page} 页</small>
            </button>
          ))}
        </aside>
        <section className="viewer-column">
          <div className="viewer-toolbar">
            <div><button onClick={() => store.setPage(Math.max(1, activePage - 1))} disabled={activePage === 1}><ChevronLeft size={16} /></button><strong>{activePage} / {doc.pages}</strong><button onClick={() => store.setPage(Math.min(doc.pages, activePage + 1))} disabled={activePage === doc.pages}><ChevronRight size={16} /></button></div>
            <span>125%</span>
            <span>原页 · 掩码叠加 · 任一区域改动都会提升版本并使发布快照失效</span>
          </div>
          <div className="pdf-stage">
            <PdfPage
              pageNumber={activePage}
              onDraw={redactionMode ? (region) => store.addRedaction({ ...region, page: activePage, reason, privilege }) : undefined}
            />
            {pageRegions.map((region) => (
              <button
                key={region.id}
                className={`redaction-region ${region.status} ${activeRedactionId === region.id ? 'selected' : ''}`}
                style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
                onClick={() => store.selectRedaction(region.id)}
                title={`${region.reason} / ${region.privilege}`}
              />
            ))}
          </div>
        </section>
        <aside className="inspector">
          <div className="side-label">区域属性</div>
          {active ? (
            <>
              <div className="inspector-title"><strong>{active.reason}</strong><Badge tone={active.status === 'confirmed' ? 'green' : 'amber'}>{active.status === 'confirmed' ? '已确认' : '草稿'}</Badge></div>
              <label>保密级别<select value={doc.classification} onChange={(event) => store.updateClassification(event.target.value as DisclosureRecord['classification'])}><option>内部</option><option>机密</option><option>严格机密</option></select></label>
              <label>去密原因<input value={active.reason} readOnly /></label>
              <label>特权标签<input value={active.privilege} readOnly /></label>
              <label>责任人员<input value={doc.owner} readOnly /></label>
              <div className="coordinate-grid"><div><span>X</span><b>{Math.round(active.x * 100)}%</b></div><div><span>Y</span><b>{Math.round(active.y * 100)}%</b></div><div><span>宽</span><b>{Math.round(active.width * 100)}%</b></div><div><span>高</span><b>{Math.round(active.height * 100)}%</b></div></div>
              <Button onClick={() => store.confirmRedaction(active.id)} disabled={active.status === 'confirmed'}><Check size={15} /> 确认此区域</Button>
              <Button variant="outline"><Copy size={15} /> 批量复制到同类页</Button>
            </>
          ) : <p className="muted">在文档页面上选择一个去密区域查看属性。</p>}
          <div className="rule-note"><AlertTriangle size={16} /><span>确认/新增区域会提升内容版本：旧发布快照立即失效，双人须重新对照原页与发布页。</span></div>
        </aside>
      </div>
      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>发布前校验</Dialog.Title>
            <Dialog.Description>系统将核对原始页与发布页的一致性，并检查元数据残留。</Dialog.Description>
            <div className="dialog-checks">
              <p><Check /> {doc.redactions.length} 个去密区域已定位（当前 v{doc.review.contentVersion}）</p>
              <p><Check /> 文档版本与操作者记录完整</p>
              <p className={doc.redactions.some((item) => item.status === 'draft') ? 'failed' : ''}><AlertTriangle /> {doc.redactions.some((item) => item.status === 'draft') ? '仍有未确认区域' : '所有区域已确认'}</p>
              <p className={fresh ? '' : 'failed'}>{fresh ? <Check /> : <AlertTriangle />} {fresh ? '发布快照与当前版本一致' : '发布快照缺失或已失效，需在发布质控页重新对照生成'}</p>
            </div>
            <Dialog.Close asChild><Button>返回检查 <X size={15} /></Button></Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

type Notice = { tone: 'ok' | 'err' | 'info'; text: string };

function ReviewerPanel({ doc, reviewerId, notices, setNotices }: {
  doc: DisclosureRecord;
  reviewerId: ReviewerId;
  notices: Record<string, Notice>;
  setNotices: React.Dispatch<React.SetStateAction<Record<string, Notice>>>;
}) {
  const store = useDisclosureStore();
  const reviewer = REVIEWERS.find((item) => item.id === reviewerId)!;
  const review = doc.review;
  const wc = review.workingCopies.find((item) => item.reviewerId === reviewerId) ?? null;
  const currentConclusion = review.conclusions.find((c) => c.reviewerId === reviewerId && c.version === review.contentVersion) ?? null;
  const isConflict = review.conflict?.reviewerId === reviewerId;
  const compared = review.comparedBy[reviewerId] === review.contentVersion;
  const fresh = isSnapshotFresh(doc);
  const noticeKey = `submit-${reviewerId}`;
  const [busy, setBusy] = useState(false);
  const notice = notices[noticeKey];

  const submit = async () => {
    setBusy(true);
    const result = await store.submitConclusion(doc.id, reviewerId);
    setBusy(false);
    if (result.ok) setNotices((prev) => ({ ...prev, [noticeKey]: { tone: 'ok', text: '提交成功：本版本已记录你的复核结论' } }));
    else if (result.code === 'conflict') setNotices((prev) => ({ ...prev, [noticeKey]: { tone: 'err', text: result.text ?? '提交冲突，现场已保留' } }));
    else setNotices((prev) => ({ ...prev, [noticeKey]: { tone: 'err', text: result.text ?? '暂不能提交' } }));
  };

  return (
    <Card className={`reviewer-card ${isConflict ? 'in-conflict' : ''} ${currentConclusion?.decision === 'approve' ? 'approved' : ''}`}>
      <div className="reviewer-head">
        <div className="reviewer-avatar">{reviewer.name[0]}</div>
        <div><strong>{reviewer.name}</strong><span>{reviewer.role}</span></div>
        {currentConclusion ? (
          <Badge tone={currentConclusion.decision === 'approve' ? 'green' : 'red'}>{currentConclusion.decision === 'approve' ? `已通过 v${currentConclusion.version}` : `退回 v${currentConclusion.version}`} · {currentConclusion.at}</Badge>
        ) : isConflict ? (
          <Badge tone="red">提交冲突 · 现场保留</Badge>
        ) : wc ? (
          <Badge tone="blue">工作稿基于 v{wc.basedOnVersion}</Badge>
        ) : (
          <Badge tone="neutral">未打开工作稿</Badge>
        )}
      </div>
      {!currentConclusion && (
        <div className="reviewer-body">
          {!wc ? (
            <Button variant="outline" onClick={() => store.openWorkingCopy(doc.id, reviewerId)}><Users size={14} /> 打开复核工作稿</Button>
          ) : wc.basedOnVersion !== review.contentVersion ? (
            <div className="stale-draft">
              <AlertTriangle size={15} />
              <div>
                <strong>工作稿已落后于权威版本</strong>
                <p>你的工作稿基于 v{wc.basedOnVersion}，区域/复核项已变更到 v{review.contentVersion}。直接提交会产生冲突；请刷新对齐，并在重新对照后再下结论。</p>
              </div>
              <Button onClick={() => store.openWorkingCopy(doc.id, reviewerId)}><RefreshCw size={14} /> 刷新对齐到 v{review.contentVersion}</Button>
            </div>
          ) : (
            <>
              <div className="draft-meta">
                <span>打开于 {wc.openedAt}</span>
                <span>所见锁：{wc.observedLock ? `${REVIEWERS.find((r) => r.id === wc.observedLock?.by)?.name} @ v${wc.observedLock.version}` : '无'}</span>
              </div>
              <div className="decision-toggle">
                <button className={wc.decision === 'approve' ? 'selected approve' : ''} onClick={() => store.updateWorkingDraft(doc.id, reviewerId, { decision: 'approve' })}><Check size={13} /> 复核通过</button>
                <button className={wc.decision === 'return' ? 'selected return' : ''} onClick={() => store.updateWorkingDraft(doc.id, reviewerId, { decision: 'return' })}><ArrowLeft size={13} /> 退回补件</button>
              </div>
              <label className="compare-ack">
                <input
                  type="checkbox"
                  checked={compared}
                  disabled={!fresh}
                  onChange={() => store.acknowledgeCompared(doc.id, reviewerId)}
                />
                已逐页重新对照原页与发布页（v{review.contentVersion}）
                {!fresh && <small>快照失效，需先在下方重新生成快照</small>}
              </label>
              <Button disabled={busy || !wc.decision} onClick={submit}>
                {busy ? <RefreshCw size={14} className="spin" /> : <FileCheck2 size={14} />} 提交复核结论
              </Button>
            </>
          )}
          {notice && <p className={`inline-notice ${notice.tone}`}><AlertTriangle size={13} /> {notice.text}</p>}
        </div>
      )}
    </Card>
  );
}

function QualityPage() {
  const documents = useDisclosureStore((state) => state.documents);
  const docId = useDisclosureStore((state) => state.qualityDocumentId);
  const store = useDisclosureStore();
  const doc = documents.find((item) => item.id === docId) ?? documents[0];
  const review = doc.review;
  const fresh = isSnapshotFresh(doc);
  const gate = approvalGate(doc);
  const [page, setPage] = useState(1);
  const [notices, setNotices] = useState<Record<string, Notice>>({});
  const pageRegions = doc.redactions.filter((item) => item.page === page);
  const snapshotOp = store.snapshotOps[doc.id];
  const upgradeOp = store.upgradeOps[doc.id];
  const faults = store.injectedFaults;
  const submittedCount = review.conclusions.filter((c) => c.version === review.contentVersion && c.decision === 'approve').length;

  return (
    <div className="page quality-page">
      <header className="page-heading">
        <div><small>QUALITY ASSURANCE / SIDE-BY-SIDE</small><h1>发布质控双人复核</h1><p>去密区域、复核项与发布快照共用同一内容版本；先到提交者锁定版本，后到者遇冲突且现场保留。</p></div>
        <Button><FileCheck2 size={16} /> 导出发布清单</Button>
      </header>

      <Card className="demo-toolbar">
        <div className="card-title"><Zap size={15} /><strong>并发 / 故障演练台</strong><span>不会影响真实数据，仅用于演示版本规则</span></div>
        <div className="demo-buttons">
          <Button variant="outline" onClick={() => store.seedLegacyDraft(false)}>注入旧草稿（升级成功）</Button>
          <Button variant="outline" onClick={() => store.seedLegacyDraft(true)}>注入旧草稿（首次写入失败 → 按编号重试）</Button>
          <Button variant="outline" onClick={() => store.setInjectedFault({ snapshot: 'snapshot-fail' })}>下次快照：写入失败</Button>
          <Button variant="outline" onClick={() => store.setInjectedFault({ snapshot: 'snapshot-lost' })}>下次快照：响应丢失</Button>
          <Button variant="ghost" onClick={() => store.resetDemo()}><RotateCcw size={14} /> 重置演示数据</Button>
        </div>
        {(faults.snapshot || faults.upgrade) && (
          <p className="fault-armed"><AlertTriangle size={13} /> 已挂起故障：
            {faults.snapshot === 'snapshot-fail' && ' 快照写入将失败（可用按钮重试，不重复留快照）'}
            {faults.snapshot === 'snapshot-lost' && ' 快照响应将丢失（自动按幂等键重试恢复）'}
            {faults.upgrade === 'upgrade-fail' && ' 旧草稿升级首次写入将失败'}
          </p>
        )}
      </Card>

      <div className="quality-doc-tabs">
        {documents.map((item) => (
          <button key={item.id} className={item.id === doc.id ? 'active' : ''} onClick={() => { store.setQualityDocument(item.id); setPage(1); setNotices({}); }}>
            <strong>{item.id}</strong><span>{item.title}</span><i className={`tab-dot ${isSnapshotFresh(item) ? 'fresh' : item.review.snapshot ? 'stale' : 'none'}`} />
          </button>
        ))}
      </div>

      {review.pendingUpgrade && (
        <div className="upgrade-banner">
          <Zap size={16} />
          <div>
            <strong>检测到旧版草稿（{doc.id}）</strong>
            <span>升级会保留原去密区域、复核勾选与处理记录，升级写入按文档编号幂等恢复，不会重复生成快照。</span>
            {upgradeOp && <small>状态：{upgradeOp.message}（尝试 {upgradeOp.attempts} 次）</small>}
          </div>
          <Button variant="outline" onClick={() => store.retryUpgrade(doc.id)} disabled={upgradeOp?.status === 'running'}><RefreshCw size={14} /> 按文档编号重试恢复</Button>
        </div>
      )}
      {!review.pendingUpgrade && upgradeOp?.status === 'done' && (
        <div className="upgrade-banner done">
          <Check size={16} />
          <div><strong>{doc.id} 旧草稿升级完成</strong><span>{upgradeOp.message}</span></div>
        </div>
      )}

      <div className="comparison-banner">
        <div><Eye size={17} /><strong>{doc.title}</strong><span>{doc.id} · 内容版本 v{review.contentVersion} · 双人复核 {submittedCount}/2 已通过</span></div>
        <div className="banner-right">
          <label className="actor-switch">
            当前操作者
            <select value={store.activeReviewer} onChange={(event) => store.setActiveReviewer(event.target.value as ReviewerId)}>
              {REVIEWERS.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}（{reviewer.role}）</option>)}
            </select>
          </label>
          {review.lock && review.lock.version === review.contentVersion ? (
            <Badge tone="blue"><Lock size={11} /> v{review.lock.version} 已被 {REVIEWERS.find((r) => r.id === review.lock?.by)?.name} 先到锁定（{review.lock.at}）</Badge>
          ) : (
            <Badge tone="amber">版本未锁定 · 等待先到提交</Badge>
          )}
        </div>
      </div>

      <div className="snapshot-bar">
        <div className="snapshot-state">
          {fresh ? (
            <>
              <i className="snap-led fresh" />
              <strong>发布快照有效</strong>
              <span>v{review.snapshot!.version} · 指纹 {review.snapshot!.fingerprint} · {REVIEWERS.find((r) => r.id === review.snapshot!.createdBy)?.name} 于 {review.snapshot!.createdAt} 生成</span>
            </>
          ) : review.snapshot ? (
            <>
              <i className="snap-led stale" />
              <strong>发布快照已失效</strong>
              <span>快照基于 v{review.snapshot.version}，区域/复核项已变更到 v{review.contentVersion}；必须重新对照后才能批准</span>
            </>
          ) : (
            <>
              <i className="snap-led none" />
              <strong>尚无发布快照</strong>
              <span>并排核对原页与发布页后生成快照，快照将绑定当前版本与内容指纹</span>
            </>
          )}
        </div>
        <Button variant={fresh ? 'outline' : 'primary'} disabled={snapshotOp?.status === 'running' || snapshotOp?.status === 'recovering'} onClick={() => store.createSnapshot(doc.id, store.activeReviewer)}>
          <RefreshCw size={14} className={snapshotOp?.status === 'running' || snapshotOp?.status === 'recovering' ? 'spin' : ''} />
          {fresh ? '重新对照并重建快照' : '原页/发布页对照完成，生成快照'}
        </Button>
      </div>
      {snapshotOp && (
        <div className={`op-banner ${snapshotOp.status === 'failed' ? 'failed' : snapshotOp.status === 'ok' ? 'ok' : 'running'}`}>
          {snapshotOp.status === 'failed' ? <AlertTriangle size={14} /> : snapshotOp.status === 'ok' ? <Check size={14} /> : <RefreshCw size={14} className="spin" />}
          <span>{snapshotOp.message}</span>
          {snapshotOp.status === 'failed' && <Button variant="outline" onClick={() => store.createSnapshot(doc.id, store.activeReviewer)}>按 {doc.id} 重试</Button>}
        </div>
      )}

      <div className="compare-grid">
        <Card className="compare-panel">
          <div className="compare-head">
            <span>原始页</span>
            <div className="page-switcher"><button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}><ChevronLeft size={14} /></button><strong>{page}/{doc.pages}</strong><button onClick={() => setPage((p) => Math.min(doc.pages, p + 1))} disabled={page === doc.pages}><ChevronRight size={14} /></button></div>
            <Badge tone="neutral">源文件</Badge>
          </div>
          <div className="compare-page"><PdfPage pageNumber={page} /></div>
        </Card>
        <Card className="compare-panel">
          <div className="compare-head"><span>发布页</span><Badge tone="green">{fresh ? `按 v${review.contentVersion} 快照遮蔽` : '遮蔽与当前版本不一致'}</Badge></div>
          <div className="compare-page redacted-preview">
            <PdfPage pageNumber={page} redacted />
            {pageRegions.map((region) => (
              <i key={region.id} className={`redaction-mask ${region.status}`} style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} />
            ))}
          </div>
        </Card>
      </div>

      <div className="reviewer-grid">
        {REVIEWERS.map((reviewer) => (
          <ReviewerPanel key={reviewer.id} doc={doc} reviewerId={reviewer.id} notices={notices} setNotices={setNotices} />
        ))}
      </div>

      {review.conflict && <ConflictCard doc={doc} />}

      <div className="quality-bottom">
        <Card className="checks-card">
          <div className="card-title"><ClipboardCheck size={17} /><strong>发布前校验项（权威版本）</strong><span>勾选改动立即提升内容版本</span></div>
          {REVIEW_CHECKS.map((check) => (
            <button className="check-row" key={check.id} onClick={() => store.toggleReviewCheck(doc.id, check.id)}>
              <span className={review.checks[check.id] ? 'checked' : ''}>{review.checks[check.id] && <Check size={13} />}</span>
              <div><strong>{check.label}</strong><small>{check.detail}</small></div>
              <Badge tone={review.checks[check.id] ? 'green' : 'neutral'}>{review.checks[check.id] ? 'v' + review.contentVersion : '未通过'}</Badge>
            </button>
          ))}
          <label className="metadata-row">
            <input type="checkbox" checked={review.metadataCleaned} onChange={() => store.toggleMetadata(doc.id)} />
            <div><strong>已确认元数据清理</strong><small>作者、修订人、批注和隐藏字段（改动同样提升版本）</small></div>
          </label>
        </Card>

        <Card className="decision-card">
          <div className="card-title"><ShieldCheck size={17} /><strong>发布门禁</strong></div>
          <div className="gate-list">
            <GateRow ok={!!review.snapshot} text="已生成发布快照" />
            <GateRow ok={fresh} text={`快照与当前 v${review.contentVersion} 区域/复核项指纹一致`} />
            <GateRow ok={REVIEW_CHECKS.every((c) => review.checks[c.id])} text="4 项复核项全部通过" />
            <GateRow ok={review.metadataCleaned} text="元数据清理已确认" />
            {REVIEWERS.map((reviewer) => {
              const c = review.conclusions.find((item) => item.reviewerId === reviewer.id && item.version === review.contentVersion);
              return <GateRow key={reviewer.id} ok={c?.decision === 'approve'} text={`${reviewer.name} 在 v${review.contentVersion} 提交通过`} />;
            })}
            {REVIEWERS.map((reviewer) => (
              <GateRow key={`cmp-${reviewer.id}`} ok={review.comparedBy[reviewer.id] === review.contentVersion} text={`${reviewer.name} 已逐页重新对照 v${review.contentVersion}`} />
            ))}
            <GateRow ok={!review.conflict} text="无未决并发冲突" />
          </div>
          {!gate.ready && (
            <ul className="gate-blockers">
              {gate.reasons.map((reason) => <li key={reason}><AlertTriangle size={12} /> {reason}</li>)}
            </ul>
          )}
          <div className="decision-actions vertical">
            <Button disabled={!gate.ready} onClick={() => store.approveRelease(doc.id)}><ShieldCheck size={15} /> 通过并标记可发布</Button>
            <Button variant="outline" onClick={() => store.resetReviewCycle(doc.id)}><RotateCcw size={15} /> （演练）重置本版本双人结论</Button>
          </div>
        </Card>

        <Card className="history-card">
          <div className="card-title"><HistoryIcon size={17} /><strong>处理记录</strong><span>冲突、升级与恢复均留痕</span></div>
          <div className="history-list">
            {review.history.slice(0, 14).map((record: ProcessRecord) => {
              const Icon = historyIcon[record.kind] ?? FileText;
              return (
                <div className={`history-item kind-${record.kind}`} key={record.id}>
                  <i><Icon size={13} /></i>
                  <div><p>{record.text}</p><small><b>{record.at}</b> · {record.actor} · v{record.version}</small></div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

function GateRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p className={`gate-row ${ok ? 'ok' : 'blocked'}`}>
      {ok ? <Check size={13} /> : <X size={13} />} {text}
    </p>
  );
}

function ConflictCard({ doc }: { doc: DisclosureRecord }) {
  const store = useDisclosureStore();
  const conflict = doc.review.conflict!;
  const reviewer = REVIEWERS.find((r) => r.id === conflict.reviewerId)!;
  const wc = conflict.workingCopy;
  return (
    <Card className="conflict-card">
      <div className="conflict-head">
        <AlertTriangle size={18} />
        <div>
          <strong>{reviewer.name} 的提交发生并发冲突，工作稿现场已保留</strong>
          <p>{conflict.text}</p>
        </div>
        <Badge tone="red">{conflict.reason === 'version-moved' ? '版本已漂移' : conflict.reason === 'locked-by-other' ? '已被先到锁定' : '重复提交'}</Badge>
      </div>
      <div className="conflict-scene">
        <div className="scene-col">
          <span>提交现场</span>
          <p>基于版本 <b>v{conflict.submittedVersion}</b> · 当前权威版本 <b>v{conflict.currentVersion}</b></p>
          <p>结论：<b>{wc.decision === 'approve' ? '复核通过' : wc.decision === 'return' ? '退回补件' : '未选择'}</b> · 工作稿打开于 {wc.openedAt}</p>
          <p>所见锁：{conflict.lock ? `${REVIEWERS.find((r) => r.id === conflict.lock?.by)?.name} 于 ${conflict.lock.at} 锁定 v${conflict.lock.version}` : '无'} </p>
        </div>
        <div className="scene-col">
          <span>勾选现场（原样保留）</span>
          <ul>
            {REVIEW_CHECKS.map((check) => (
              <li key={check.id} className={wc.checks[check.id] ? 'on' : 'off'}>
                {wc.checks[check.id] ? <Check size={12} /> : <X size={12} />} {check.label}
              </li>
            ))}
            <li className={wc.metadataAck ? 'on' : 'off'}>{wc.metadataAck ? <Check size={12} /> : <X size={12} />} 元数据清理确认</li>
          </ul>
        </div>
      </div>
      <div className="conflict-actions">
        <Button onClick={() => store.resolveConflict(doc.id, 'refresh')}><RefreshCw size={14} /> 刷新到最新版本并重新对照（现场归档留痕）</Button>
        <Button variant="outline" onClick={() => store.resolveConflict(doc.id, 'discard')}>放弃该工作稿</Button>
      </div>
    </Card>
  );
}

function BatchesPage() {
  const documents = useDisclosureStore((state) => state.documents);
  const [selected, setSelected] = useState<string[]>(['DOC-00418']);
  const activeDoc = documents.find((doc) => doc.id === selected[0]) ?? documents[0];
  return (
    <div className="page">
      <header className="page-heading"><div><small>RELEASE BATCH / TAXONOMY</small><h1>发布批次与标签</h1><p>按案件问题、辖区和披露对象组织文档，生成可追溯发布清单。</p></div><Button>生成发布包</Button></header>
      <div className="batch-layout">
        <Card className="batch-list"><div className="card-title"><Layers3 size={17} /><strong>发布批次</strong></div>{['第一批披露 · 审阅中', '第二批披露 · 编制中', '专家材料 · 待补充'].map((name, index) => <button key={name} className={index === 0 ? 'active' : ''}><span>BATCH-{String(index + 1).padStart(2, '0')}</span><strong>{name}</strong><small>{[48, 79, 19][index]} 份文档</small></button>)}</Card>
        <Card className="batch-content">
          <div className="card-title"><Tags size={17} /><strong>文档与案件问题映射</strong><span>{selected.length} 已选择</span></div>
          <div className="batch-table">
            {documents.map((doc) => <label key={doc.id} className="batch-row"><input type="checkbox" checked={selected.includes(doc.id)} onChange={() => setSelected((ids) => ids.includes(doc.id) ? ids.filter((id) => id !== doc.id) : [...ids, doc.id])} /><FileText size={17} /><div><strong>{doc.title}</strong><span>{doc.id} · v{doc.review.contentVersion} · {doc.issue}</span></div><Badge tone={doc.status === '可发布' ? 'green' : 'amber'}>{doc.status}</Badge></label>)}
          </div>
          <div className="tag-editor"><h3>标签与分发级</h3><div className="tag-options">{(['合同问题', '设备缺陷', '现场安全', '损害赔偿', '仅律师可见']).map((tag, index) => <span key={tag} className={index < 3 ? 'selected' : ''}>{tag}</span>)}</div><label>导出清单说明<textarea defaultValue="按案卷编号升序导出，保留去密版本、操作者与审批时间。" /></label><Button>保存批次设置</Button></div>
        </Card>
        <Card className="batch-summary"><div className="side-label">当前批次摘要</div><strong>{activeDoc.bundle}</strong><dl><div><dt>文档</dt><dd>{selected.length}</dd></div><div><dt>页数</dt><dd>{selected.reduce((sum, id) => sum + (documents.find((doc) => doc.id === id)?.pages ?? 0), 0)}</dd></div><div><dt>风险项</dt><dd>4</dd></div></dl><div className="summary-note"><AlertTriangle size={15} /><span>发布前仍需完成 4 项双人复核。</span></div></Card>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell });
const documentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DocumentsPage });
const reviewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/review/$documentId', component: ReviewPage });
const qualityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/quality', component: QualityPage });
const batchesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/batches', component: BatchesPage });
const routeTree = rootRoute.addChildren([documentsRoute, reviewRoute, qualityRoute, batchesRoute]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

export default function App() {
  return <RouterProvider router={router} />;
}
