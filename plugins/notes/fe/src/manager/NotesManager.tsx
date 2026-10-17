/**
 * 笔记本管理面板（/note app 打开的大窗口应用视图，布局对照图1–5）
 *
 * 左栏：笔记目录的树形列表。
 *  - 标题栏平时只显示「文件」二字，鼠标划过浮现工具按钮（搜索/刷新；
 *    新建文件与新建文件夹走目录右键菜单）
 *  - 右键菜单：改名（行内编辑）、移动、删除、复制名称、复制路径、刷新目录、
 *    在系统中打开、在系统中显示（根节点只保留新建/刷新/系统项）
 * 右栏：文件标签页 + 编辑/预览（分栏/编辑/预览与现有编辑弹窗一致，Ctrl+S 保存）
 *  + 「目录」大纲面板（图5，点击标题滚动预览定位）。
 * 搜索走 SearchDialog（图3），点击命中行打开文件并定位到行。
 */
import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from 'solid-js';
import { getPluginContext } from '@ll/sdk';
import { PopupFrame } from '@ll/ui';
import { extractToc, renderMarkdownPreview } from '../markdown';
import { SearchDialog } from './SearchDialog';
import './manager.css';

const ctx = getPluginContext('notes');

interface TreeNode {
  name: string;
  /** 绝对路径（OS 分隔符） */
  path: string;
  /** 相对笔记根的路径（/ 分隔），根为空串 */
  rel: string;
  kind: 'dir' | 'file';
  size?: number;
  children?: TreeNode[];
}

interface CreatedNote {
  path: string;
  title: string;
}

interface RenameResult {
  path: string;
  name: string;
}

type ManagerDialog =
  | { kind: 'new-file'; parentPath: string; parentLabel: string }
  | { kind: 'new-folder'; parentPath: string; parentLabel: string }
  | { kind: 'move'; path: string; name: string; rel: string }
  | { kind: 'delete'; path: string; name: string; isDir: boolean }
  | { kind: 'discard'; message: string; proceed: () => void }
  | null;

interface MenuItemDef {
  key: string;
  label: string;
  danger?: boolean;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 浏览器预览环境（vite dev 无宿主）的静态示例树，交互全部降级展示 */
const MOCK_TREE: TreeNode = {
  name: 'LiteNotes',
  path: 'C:\\Users\\demo\\Documents\\LiteNotes',
  rel: '',
  kind: 'dir',
  children: [
    {
      name: 'Work',
      path: 'C:\\Users\\demo\\Documents\\LiteNotes\\Work',
      rel: 'Work',
      kind: 'dir',
      children: [
        {
          name: '周报.md',
          path: 'C:\\Users\\demo\\Documents\\LiteNotes\\Work\\周报.md',
          rel: 'Work/周报.md',
          kind: 'file',
        },
      ],
    },
    {
      name: 'LiteLauncher 快速入门指南.md',
      path: 'C:\\Users\\demo\\Documents\\LiteNotes\\LiteLauncher 快速入门指南.md',
      rel: 'LiteLauncher 快速入门指南.md',
      kind: 'file',
    },
  ],
};

export const NotesManager: Component = () => {
  // ── 目录树状态 ──
  const [tree, setTree] = createSignal<TreeNode | null>(null);
  const [rootExpanded, setRootExpanded] = createSignal(true);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [selected, setSelected] = createSignal<TreeNode | null>(null);
  const [status, setStatus] = createSignal('');

  // ── 右键菜单 / 行内改名 ──
  const [menu, setMenu] = createSignal<{ x: number; y: number; node: TreeNode } | null>(null);
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');

  // ── 编辑器状态（与现有编辑弹窗一致的行为） ──
  const [openNode, setOpenNode] = createSignal<TreeNode | null>(null);
  const [content, setContent] = createSignal('');
  const [dirty, setDirty] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal('已同步');
  const [mode, setMode] = createSignal<'split' | 'edit' | 'preview'>('split');
  const [tocOpen, setTocOpen] = createSignal(false);

  // ── 弹窗 ──
  const [dialog, setDialog] = createSignal<ManagerDialog>(null);
  const [dialogInput, setDialogInput] = createSignal('');
  const [dialogTarget, setDialogTarget] = createSignal('');
  const [dialogBusy, setDialogBusy] = createSignal(false);
  const [dialogError, setDialogError] = createSignal('');
  const [showSearch, setShowSearch] = createSignal(false);

  let textareaRef: HTMLTextAreaElement | undefined;
  let previewRef: HTMLDivElement | undefined;

  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  const flash = (msg: string) => {
    setStatus(msg);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => setStatus(''), 2600);
  };

  // ── 树加载 ──
  const loadTree = async () => {
    if (!isTauri()) {
      setTree(MOCK_TREE);
      return;
    }
    try {
      const root = await ctx.call<TreeNode>('tree', {});
      setTree(root);
    } catch (err) {
      flash(`加载目录失败: ${err}`);
    }
  };

  onMount(() => {
    void loadTree();
    // 点击空白处关闭右键菜单
    const onDocClick = () => setMenu(null);
    window.addEventListener('click', onDocClick);
    window.addEventListener('blur', onDocClick);
    onCleanup(() => {
      window.removeEventListener('click', onDocClick);
      window.removeEventListener('blur', onDocClick);
      if (statusTimer) clearTimeout(statusTimer);
    });
  });

  // ── 树工具函数 ──
  const findNodeByPath = (node: TreeNode | null, path: string): TreeNode | null => {
    if (!node) return null;
    if (node.path === path) return node;
    for (const child of node.children ?? []) {
      const hit = findNodeByPath(child, path);
      if (hit) return hit;
    }
    return null;
  };

  /** 文件的父目录节点；根或目录返回自身 */
  const parentDirOf = (node: TreeNode): TreeNode => {
    if (node.kind === 'dir') return node;
    const parentPath = node.path.slice(0, node.path.length - node.name.length - 1);
    return findNodeByPath(tree(), parentPath) ?? tree()!;
  };

  /** 按 rel 找节点（目录改名/移动后 openNode 重映射用；rel 是刷新前后唯一稳定的身份） */
  const findNodeByRel = (node: TreeNode | null, rel: string): TreeNode | null => {
    if (!node) return null;
    if (node.rel === rel) return node;
    for (const child of node.children ?? []) {
      const hit = findNodeByRel(child, rel);
      if (hit) return hit;
    }
    return null;
  };

  const labelOf = (node: TreeNode): string => (node.rel === '' ? `${node.name}（根目录）` : node.rel);

  const flattenDirs = (node: TreeNode | null, out: TreeNode[] = []): TreeNode[] => {
    if (!node || node.kind !== 'dir') return out;
    out.push(node);
    for (const c of node.children ?? []) flattenDirs(c, out);
    return out;
  };

  /** 移动目标候选：排除自身、自身后代与当前父目录（移入原目录 = 无操作） */
  const moveTargetDirs = (): TreeNode[] => {
    const d = dialog();
    const self = d && d.kind === 'move' ? d.path : '';
    const selfName = d && d.kind === 'move' ? d.name : '';
    const parentPath = self ? self.slice(0, self.length - selfName.length - 1) : '';
    return flattenDirs(tree()).filter((x) => {
      if (!self || x.path === self) return false;
      if (x.path.startsWith(self + '\\') || x.path.startsWith(self + '/')) return false;
      if (parentPath && x.path === parentPath) return false;
      return true;
    });
  };

  const toggleDir = (node: TreeNode) => {
    setSelected(node);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.rel)) next.delete(node.rel);
      else next.add(node.rel);
      return next;
    });
  };

  /** 展开某节点并向上展开全部祖先（新建/移动后定位用） */
  const expandTo = (rel: string) => {
    if (!rel) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const segs = rel.split('/');
      segs.pop(); // 目标本体是文件时无需展开自身
      let acc = '';
      for (const seg of segs) {
        acc = acc ? `${acc}/${seg}` : seg;
        next.add(acc);
      }
      return next;
    });
  };

  const refreshTree = async (expandRel?: string) => {
    await loadTree();
    if (expandRel) expandTo(expandRel);
  };

  // ── 编辑器核心（读/存与现有编辑弹窗一致） ──
  const doOpenFile = async (node: TreeNode, jumpLine?: number) => {
    setSelected(node);
    if (!isTauri()) {
      setOpenNode(node);
      setContent(`# ${node.name}\n\n（浏览器预览模式的示例内容）`);
      setDirty(false);
      setSaveStatus('[预览] 已同步');
      return;
    }
    try {
      const text = await ctx.call<string>('read', { path: node.path });
      setOpenNode(node);
      setContent(text);
      setDirty(false);
      setSaveStatus('已同步');
      if (jumpLine) jumpToLine(jumpLine);
    } catch (err) {
      flash(`无法打开文件: ${err}`);
    }
  };

  const openFile = (node: TreeNode, jumpLine?: number) => {
    if (node.kind !== 'file') return;
    setSelected(node);
    if (node.path === openNode()?.path) {
      if (jumpLine) jumpToLine(jumpLine);
      return;
    }
    guardDirty(() => void doOpenFile(node, jumpLine));
  };

  const closeEditor = () => {
    setOpenNode(null);
    setContent('');
    setDirty(false);
    setSaveStatus('已同步');
  };

  const save = async () => {
    const node = openNode();
    if (!node) return;
    if (!isTauri()) {
      setDirty(false);
      setSaveStatus('[预览] 已保存');
      return;
    }
    try {
      await ctx.call('save', { path: node.path, content: content() });
      setDirty(false);
      setSaveStatus('已保存 ✓');
      setTimeout(() => setSaveStatus('已同步'), 2000);
    } catch (err) {
      setSaveStatus(`保存失败: ${err}`);
    }
  };

  const handleInput = (val: string) => {
    setContent(val);
    setDirty(true);
    setSaveStatus('未保存 *');
  };

  /** 跳到指定行（搜索结果定位）：选中该行并把视口滚过去；预览态先切回分栏让编辑器现身 */
  const jumpToLine = (line: number) => {
    if (mode() === 'preview') setMode('split');
    requestAnimationFrame(() => {
      const ta = textareaRef;
      if (!ta) return;
      const lines = content().split('\n');
      let start = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) start += lines[i].length + 1;
      const end = start + (lines[line - 1]?.length ?? 0);
      ta.focus();
      ta.setSelectionRange(start, end);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 23;
      ta.scrollTop = Math.max(0, (line - 6) * lh);
    });
  };

  /** 大纲定位（图5）：点击目录项滚动预览区到对应标题 */
  const jumpToAnchor = (anchor: string) => {
    if (mode() === 'edit') setMode('split');
    requestAnimationFrame(() => {
      previewRef?.querySelector(`[id="${anchor}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // ── 未保存守卫：切换/关闭文件前确认（保存并继续 / 放弃修改 / 取消） ──
  const guardDirty = (proceed: () => void) => {
    if (!dirty()) {
      proceed();
      return;
    }
    setDialog({
      kind: 'discard',
      message: `「${openNode()?.name ?? ''}」有未保存的修改，继续前要保存吗？`,
      proceed,
    });
  };

  // ── 窗口关闭 ──
  const closeWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  };

  const handleWindowClose = () => {
    if (dirty()) {
      setDialog({
        kind: 'discard',
        message: '当前文件有未保存的修改，关闭窗口前要保存吗？',
        proceed: () => void closeWindow(),
      });
      return;
    }
    void closeWindow();
  };

  // ── 右键菜单 ──
  const menuItems = (node: TreeNode): MenuItemDef[] => {
    if (node.rel === '') {
      return [
        { key: 'new-file', label: '新建文件' },
        { key: 'new-folder', label: '新建文件夹' },
        { key: 'refresh', label: '刷新目录' },
        { key: 'open-system', label: '在系统中打开' },
        { key: 'reveal-system', label: '在系统中显示' },
      ];
    }
    // 顺序对照需求：改名、移动、删除、复制名称、复制路径、刷新目录、在系统中打开、在系统中显示
    const items: MenuItemDef[] = [
      { key: 'rename', label: '改名' },
      { key: 'move', label: '移动…' },
      { key: 'delete', label: '删除…', danger: true },
      { key: 'copy-name', label: '复制名称' },
      { key: 'copy-path', label: '复制路径' },
    ];
    if (node.kind === 'dir') items.push({ key: 'refresh', label: '刷新目录' });
    items.push({ key: 'open-system', label: '在系统中打开' });
    items.push({ key: 'reveal-system', label: '在系统中显示' });
    return items;
  };

  const copyText = async (text: string) => {
    if (!isTauri()) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 浏览器预览环境忽略 */
      }
      return;
    }
    await ctx.clipboard.write(text);
  };

  const runMenuAction = async (key: string) => {
    const node = menu()?.node;
    setMenu(null);
    if (!node) return;
    switch (key) {
      case 'rename':
        setRenameValue(node.name);
        setRenamingPath(node.path);
        break;
      case 'move': {
        setDialogTarget(parentDirOf(node).path);
        setDialogInput('');
        setDialogError('');
        setDialog({ kind: 'move', path: node.path, name: node.name, rel: node.rel });
        break;
      }
      case 'delete':
        setDialog({ kind: 'delete', path: node.path, name: node.name, isDir: node.kind === 'dir' });
        break;
      case 'copy-name':
        await copyText(node.name);
        flash('已复制名称');
        break;
      case 'copy-path':
        await copyText(node.path);
        flash('已复制路径');
        break;
      case 'refresh':
        await refreshTree();
        flash('目录已刷新');
        break;
      case 'open-system':
        try {
          await ctx.call('open_in_system', { path: node.path });
        } catch (err) {
          flash(`打开失败: ${err}`);
        }
        break;
      case 'reveal-system':
        try {
          await ctx.call('reveal_in_system', { path: node.path });
        } catch (err) {
          flash(`定位失败: ${err}`);
        }
        break;
      case 'new-file': {
        const dir = parentDirOf(node);
        setDialogInput('');
        setDialogError('');
        setDialog({ kind: 'new-file', parentPath: dir.path, parentLabel: labelOf(dir) });
        break;
      }
      case 'new-folder': {
        const dir = parentDirOf(node);
        setDialogInput('');
        setDialogError('');
        setDialog({ kind: 'new-folder', parentPath: dir.path, parentLabel: labelOf(dir) });
        break;
      }
    }
  };

  const menuStyle = (): { left: string; top: string } => {
    const m = menu();
    if (!m) return { left: '0px', top: '0px' };
    const itemH = 30;
    const pad = 12;
    const h = menuItems(m.node).length * itemH + pad * 2;
    return {
      left: `${Math.min(m.x, window.innerWidth - 180)}px`,
      top: `${Math.max(8, Math.min(m.y, window.innerHeight - h - 8))}px`,
    };
  };

  // ── 行内改名提交 ──
  const commitRename = async (node: TreeNode) => {
    const value = renameValue().trim();
    setRenamingPath(null);
    if (!value || value === node.name) return;
    if (!isTauri()) {
      flash('[预览] 重命名');
      return;
    }
    const oldOpen = openNode();
    try {
      const res = await ctx.call<RenameResult>('rename', { path: node.path, new_name: value });
      const parentRel = node.rel.slice(0, node.rel.length - node.name.length);
      const newRel = `${parentRel}${res.name}`;
      // 目录改名后把已展开状态的 rel 前缀迁移到新名字，避免子树收起
      if (node.kind === 'dir') {
        setExpanded((prev) => {
          const next = new Set<string>();
          for (const r of prev) {
            next.add(r === node.rel || r.startsWith(`${node.rel}/`) ? newRel + r.slice(node.rel.length) : r);
          }
          return next;
        });
      }
      await loadTree();
      // 打开中的文件重映射：文件改名按精确 rel；目录改名按 rel 前缀迁后代（避免 save() 写回旧路径）
      if (oldOpen) {
        let newOpenRel: string | null = null;
        if (oldOpen.rel === node.rel) {
          newOpenRel = newRel;
        } else if (node.kind === 'dir' && oldOpen.rel.startsWith(`${node.rel}/`)) {
          newOpenRel = newRel + oldOpen.rel.slice(node.rel.length);
        }
        if (newOpenRel !== null) {
          const fresh = findNodeByRel(tree(), newOpenRel);
          if (fresh) setOpenNode(fresh);
        }
      }
      flash('已重命名');
    } catch (err) {
      flash(`重命名失败: ${err}`);
    }
  };

  // ── 新建（空态按钮；目录右键另有同名入口） ──
  const startNewFile = () => {
    const dir = selected() ? parentDirOf(selected()!) : tree();
    if (!dir) return;
    setDialogInput('');
    setDialogError('');
    setDialog({ kind: 'new-file', parentPath: dir.path, parentLabel: labelOf(dir) });
  };

  const submitNewFile = async () => {
    const d = dialog();
    if (!d || (d.kind !== 'new-file' && d.kind !== 'new-folder')) return;
    const raw = dialogInput().trim();
    if (!raw) {
      setDialogError('名称不能为空');
      return;
    }
    setDialogBusy(true);
    setDialogError('');
    try {
      if (!isTauri()) {
        flash('[预览] 新建');
        setDialog(null);
        return;
      }
      if (d.kind === 'new-file') {
        const title = raw.replace(/\.md$/i, '');
        const created = await ctx.call<CreatedNote>('create', { title, parent: d.parentPath });
        await loadTree();
        setDialog(null);
        const fresh = findNodeByPath(tree(), created.path);
        if (fresh) {
          expandTo(fresh.rel);
          // 走 openFile 让未保存守卫接管（直接 doOpenFile 会静默丢弃当前修改）
          openFile(fresh);
        }
        flash(`已创建「${created.title}」`);
      } else {
        await ctx.call('create_dir', { parent: d.parentPath, name: raw });
        await loadTree();
        setDialog(null);
        const parentRel = findNodeByPath(tree(), d.parentPath)?.rel ?? '';
        expandTo(parentRel ? `${parentRel}/${raw}` : raw);
        flash('已创建文件夹');
      }
    } catch (err: any) {
      setDialogError(String(err?.message || err));
    } finally {
      setDialogBusy(false);
    }
  };

  const submitMove = async () => {
    const d = dialog();
    if (!d || d.kind !== 'move') return;
    const target = dialogTarget();
    if (!target) {
      setDialogError('请选择目标文件夹');
      return;
    }
    setDialogBusy(true);
    setDialogError('');
    try {
      if (!isTauri()) {
        flash('[预览] 移动');
        setDialog(null);
        return;
      }
      const oldOpen = openNode();
      const res = await ctx.call<RenameResult>('move_entry', { path: d.path, target_dir: target });
      await loadTree();
      setDialog(null);
      // 打开中的文件重映射：移动目录时按 rel 前缀迁后代（避免 save() 写回旧路径）
      if (oldOpen) {
        let newOpenRel: string | null = null;
        if (oldOpen.rel === d.rel) {
          newOpenRel = findNodeByPath(tree(), res.path)?.rel ?? null;
        } else if (oldOpen.rel.startsWith(`${d.rel}/`)) {
          const freshRoot = findNodeByPath(tree(), res.path);
          if (freshRoot) newOpenRel = freshRoot.rel + oldOpen.rel.slice(d.rel.length);
        }
        if (newOpenRel !== null) {
          const fresh = findNodeByRel(tree(), newOpenRel);
          if (fresh) setOpenNode(fresh);
        }
      }
      flash(`已移动「${res.name}」`);
    } catch (err: any) {
      setDialogError(String(err?.message || err));
    } finally {
      setDialogBusy(false);
    }
  };

  const submitDelete = async () => {
    const d = dialog();
    if (!d || d.kind !== 'delete') return;
    setDialogBusy(true);
    setDialogError('');
    try {
      if (isTauri()) {
        await ctx.call('delete', { path: d.path });
        await loadTree();
      }
      setDialog(null);
      // 被删的是当前打开文件（或其所在目录）→ 关闭编辑区
      const op = openNode()?.path ?? '';
      if (d.isDir ? op.startsWith(d.path + '\\') || op.startsWith(d.path + '/') : op === d.path) {
        closeEditor();
      }
      flash(d.isDir ? '文件夹已删除' : '文件已删除');
    } catch (err: any) {
      setDialogError(String(err?.message || err));
    } finally {
      setDialogBusy(false);
    }
  };

  const submitDiscard = async (saveFirst: boolean) => {
    const d = dialog();
    if (!d || d.kind !== 'discard' || dialogBusy()) return;
    setDialogBusy(true);
    try {
      if (saveFirst) await save();
      setDialog(null);
      d.proceed();
    } finally {
      setDialogBusy(false);
    }
  };

  // ── 键盘：Ctrl+S 保存；Esc 逐层退出（菜单 → 弹窗 → 搜索） ──
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === 'Escape') {
      if (menu()) {
        setMenu(null);
        return;
      }
      if (dialog()) {
        setDialog(null);
        return;
      }
      if (showSearch()) {
        setShowSearch(false);
      }
    }
  };
  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });

  // 大纲随内容实时刷新
  const tocEntries = () => extractToc(content());

  // ── 树行（递归组件，闭包访问面板状态） ──
  const TreeItem: Component<{ node: TreeNode; depth: number }> = (p) => {
    const isDir = () => p.node.kind === 'dir';
    const expandedNow = () => isDir() && expanded().has(p.node.rel);
    const isRenaming = () => renamingPath() === p.node.path;
    const isActive = () => openNode()?.path === p.node.path;
    const isSelected = () => selected()?.path === p.node.path;

    return (
      <div>
        <div
          class={`ntree-row ${isDir() ? 'dir' : 'file'}`}
          classList={{ active: isActive(), selected: isSelected() && !isActive() }}
          style={{ 'padding-left': `${6 + p.depth * 14}px` }}
          title={p.node.rel}
          onClick={() => (isDir() ? toggleDir(p.node) : openFile(p.node))}
          onContextMenu={(e) => {
            e.preventDefault();
            setSelected(p.node);
            setMenu({ x: e.clientX, y: e.clientY, node: p.node });
          }}
        >
          <Show
            when={isRenaming()}
            fallback={
              <>
                <span
                  class="ntree-caret"
                  onClick={(e) => {
                    if (isDir()) {
                      e.stopPropagation();
                      toggleDir(p.node);
                    }
                  }}
                >
                  {isDir() ? (expandedNow() ? '⌄' : '›') : ''}
                </span>
                <span class="ntree-icon">{isDir() ? (expandedNow() ? '📂' : '📁') : '📄'}</span>
                <span class="ntree-name">{p.node.name}</span>
              </>
            }
          >
            <input
              class="ntree-rename"
              value={renameValue()}
              autofocus
              onFocus={(e) => e.currentTarget.select()}
              onInput={(e) => setRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void commitRename(p.node);
                else if (e.key === 'Escape') setRenamingPath(null);
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.stopPropagation()}
            />
          </Show>
        </div>
        <Show when={isDir() && expandedNow()}>
          <For each={p.node.children ?? []}>{(child) => <TreeItem node={child} depth={p.depth + 1} />}</For>
        </Show>
      </div>
    );
  };

  // 弹窗类型收窄助手（模板里按 kind 取字段）
  const nameDialog = () => {
    const d = dialog();
    return d && (d.kind === 'new-file' || d.kind === 'new-folder') ? d : null;
  };
  const moveDialog = () => {
    const d = dialog();
    return d && d.kind === 'move' ? d : null;
  };
  const deleteDialog = () => {
    const d = dialog();
    return d && d.kind === 'delete' ? d : null;
  };
  const discardDialog = () => {
    const d = dialog();
    return d && d.kind === 'discard' ? d : null;
  };

  return (
    <PopupFrame
      fill
      title={<span>📝 笔记</span>}
      actions={
        <>
          <div class="editor-tab-switch">
            <button
              class={`tab-btn ${mode() === 'split' ? 'active' : ''}`}
              onClick={() => setMode('split')}
            >
              分栏
            </button>
            <button
              class={`tab-btn ${mode() === 'edit' ? 'active' : ''}`}
              onClick={() => setMode('edit')}
            >
              编辑
            </button>
            <button
              class={`tab-btn ${mode() === 'preview' ? 'active' : ''}`}
              onClick={() => setMode('preview')}
            >
              预览
            </button>
          </div>
          <button class="editor-save-btn" onClick={() => void save()} title="保存 (Ctrl+S)">
            💾 保存
          </button>
          <button
            class={`ntool-btn ${tocOpen() ? 'active' : ''}`}
            onClick={() => setTocOpen(!tocOpen())}
            title="目录大纲（图5 右侧面板）"
          >
            📑 目录
          </button>
        </>
      }
      onClose={handleWindowClose}
      footer={
        <div class="nfoot">
          <span class="nfoot-path" title={tree()?.path ?? ''}>
            {tree()?.path ?? ''}
          </span>
          <span class="nfoot-status">{status()}</span>
          <span class={`editor-save-badge ${dirty() ? 'unsaved' : 'saved'}`}>{saveStatus()}</span>
        </div>
      }
    >
      <div class="nmanager-root">
        {/* ── 左栏：目录树 ── */}
        <aside class="ntree-side">
          <div class="ntree-head">
            <span class="ntree-title">文件</span>
            <div class="ntree-tools">
              <div class="ntree-tools-group">
                <button type="button" class="ntool-btn" title="搜索文件" onClick={() => setShowSearch(true)}>
                  🔍
                </button>
              </div>
              <div class="ntree-tools-group">
                <button
                  type="button"
                  class="ntool-btn"
                  title="刷新目录"
                  onClick={() => void refreshTree()}
                >
                  ⟳
                </button>
              </div>
            </div>
          </div>

          <div class="ntree-body">
            <Show
              when={tree()}
              fallback={<div class="ntree-empty">{isTauri() ? '目录加载中…' : '（浏览器预览示例）'}</div>}
            >
              {(root) => (
                <>
                  <div
                    class="ntree-row dir root"
                    classList={{ active: selected()?.rel === '' }}
                    onClick={() => setRootExpanded(!rootExpanded())}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(root());
                      setMenu({ x: e.clientX, y: e.clientY, node: root() });
                    }}
                    title={root().path}
                  >
                    <span
                      class="ntree-caret"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRootExpanded(!rootExpanded());
                      }}
                    >
                      {rootExpanded() ? '⌄' : '›'}
                    </span>
                    <span class="ntree-icon">{rootExpanded() ? '📂' : '📁'}</span>
                    <span class="ntree-name">{root().name}</span>
                  </div>
                  <Show when={rootExpanded()}>
                    <For each={root().children ?? []}>
                      {(child) => <TreeItem node={child} depth={1} />}
                    </For>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </aside>

        {/* ── 右栏：工作区 ── */}
        <section class="nwork">
          <Show when={openNode()}>
            <div class="nwork-tabs">
              <div class="nwork-tab" title={openNode()!.path}>
                <span class="nwork-tab-name">{openNode()!.name}</span>
                <Show when={dirty()}>
                  <span class="nwork-tab-dirty">•</span>
                </Show>
                <button
                  type="button"
                  class="nwork-tab-close"
                  title="关闭"
                  onClick={() => guardDirty(closeEditor)}
                >
                  ×
                </button>
              </div>
            </div>
          </Show>

          <Show
            when={openNode()}
            fallback={
              <div class="nwork-body">
                <div class="nwork-empty">
                  <div class="nwork-empty-icon">📝</div>
                  <div>在左侧选择一个文件开始编辑，或新建笔记</div>
                  <button type="button" class="editor-save-btn" onClick={startNewFile}>
                    ＋ 新建笔记
                  </button>
                </div>
              </div>
            }
          >
            <div class="nwork-body">
              <main class={`editor-body mode-${mode()} nwork-main`}>
                {(mode() === 'split' || mode() === 'edit') && (
                  <div class="editor-pane edit-pane">
                    <textarea
                      ref={textareaRef}
                      class="editor-textarea"
                      value={content()}
                      onInput={(e) => handleInput(e.currentTarget.value)}
                      placeholder="在此编写 Markdown 笔记..."
                      spellcheck={false}
                    />
                  </div>
                )}
                {(mode() === 'split' || mode() === 'preview') && (
                  <div
                    ref={previewRef}
                    class="editor-pane preview-pane"
                  >
                    <div
                      class="markdown-rendered-content"
                      innerHTML={renderMarkdownPreview(content())}
                    />
                  </div>
                )}
              </main>

              {/* 目录大纲（图5） */}
              <Show when={tocOpen()}>
                <aside class="nwork-toc">
                  <div class="nwork-toc-head">
                    <span>目录</span>
                    <button type="button" class="nmodal-close" title="收起目录" onClick={() => setTocOpen(false)}>
                      ×
                    </button>
                  </div>
                  <div class="nwork-toc-list">
                    <Show
                      when={tocEntries().length > 0}
                      fallback={<div class="nwork-toc-empty">本文档没有标题大纲</div>}
                    >
                      <For each={tocEntries()}>
                        {(e) => (
                          <button
                            type="button"
                            class="nwork-toc-item"
                            style={{ 'padding-left': `${8 + (e.level - 1) * 12}px` }}
                            title={e.text}
                            onClick={() => jumpToAnchor(e.anchor)}
                          >
                            <span class="nwork-toc-item-text">{e.text}</span>
                            <span class="nwork-toc-lv">h{e.level}</span>
                          </button>
                        )}
                      </For>
                    </Show>
                  </div>
                </aside>
              </Show>
            </div>
          </Show>
        </section>

        {/* ── 右键菜单 ── */}
        <Show when={menu()}>
          <div class="nmenu" style={menuStyle()} onClick={(e) => e.stopPropagation()}>
            <For each={menuItems(menu()!.node)}>
              {(item) => (
                <button
                  type="button"
                  class={`nmenu-item ${item.danger ? 'danger' : ''}`}
                  onClick={() => void runMenuAction(item.key)}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* ── 通用弹窗 ── */}
        <Show when={dialog()}>
          <div class="nmodal-mask" onClick={() => setDialog(null)}>
            <div class="nmodal" onClick={(e) => e.stopPropagation()}>
              <Switch>
                {/* 新建文件 / 新建文件夹 */}
                <Match when={nameDialog()}>
                  <div class="nmodal-head">
                    <span>{nameDialog()!.kind === 'new-file' ? '新建文件' : '新建文件夹'}</span>
                    <button type="button" class="nmodal-close" onClick={() => setDialog(null)}>
                      ×
                    </button>
                  </div>
                  <div class="nmodal-body">
                    <div class="nmodal-text">
                      位置：<span class="dim">{nameDialog()!.parentLabel}</span>
                    </div>
                    <label class="nfield">
                      <span>{nameDialog()!.kind === 'new-file' ? '文件名（.md 可省略）' : '文件夹名'}</span>
                      <input
                        class="ninput"
                        value={dialogInput()}
                        autofocus
                        placeholder={nameDialog()!.kind === 'new-file' ? '如 会议记录' : '如 项目资料'}
                        onInput={(e) => setDialogInput(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void submitNewFile();
                        }}
                        spellcheck={false}
                      />
                    </label>
                    <Show when={dialogError()}>
                      <div class="nmodal-error">{dialogError()}</div>
                    </Show>
                  </div>
                  <div class="nmodal-actions">
                    <button type="button" class="nbtn" onClick={() => setDialog(null)}>
                      取消
                    </button>
                    <button
                      type="button"
                      class="nbtn primary"
                      disabled={dialogBusy()}
                      onClick={() => void submitNewFile()}
                    >
                      创建
                    </button>
                  </div>
                </Match>

                {/* 移动 */}
                <Match when={moveDialog()}>
                  <div class="nmodal-head">
                    <span>移动「{moveDialog()!.name}」</span>
                    <button type="button" class="nmodal-close" onClick={() => setDialog(null)}>
                      ×
                    </button>
                  </div>
                  <div class="nmodal-body">
                    <label class="nfield">
                      <span>目标文件夹</span>
                      <select
                        class="nselect"
                        value={dialogTarget()}
                        onChange={(e) => setDialogTarget(e.currentTarget.value)}
                      >
                        <For each={moveTargetDirs()}>
                          {(d) => (
                            <option value={d.path}>{labelOf(d)}</option>
                          )}
                        </For>
                      </select>
                    </label>
                    <Show when={dialogError()}>
                      <div class="nmodal-error">{dialogError()}</div>
                    </Show>
                  </div>
                  <div class="nmodal-actions">
                    <button type="button" class="nbtn" onClick={() => setDialog(null)}>
                      取消
                    </button>
                    <button
                      type="button"
                      class="nbtn primary"
                      disabled={dialogBusy()}
                      onClick={() => void submitMove()}
                    >
                      移动
                    </button>
                  </div>
                </Match>

                {/* 删除确认 */}
                <Match when={deleteDialog()}>
                  <div class="nmodal-head">
                    <span>删除确认</span>
                    <button type="button" class="nmodal-close" onClick={() => setDialog(null)}>
                      ×
                    </button>
                  </div>
                  <div class="nmodal-body">
                    <div class="nmodal-text">
                      确定删除「{deleteDialog()!.name}」吗？
                      <Show when={deleteDialog()!.isDir}>
                        <br />
                        <span class="dim">文件夹将连同其中全部内容一起删除。</span>
                      </Show>
                      <br />
                      <span class="dim">此操作不可恢复。</span>
                    </div>
                    <Show when={dialogError()}>
                      <div class="nmodal-error">{dialogError()}</div>
                    </Show>
                  </div>
                  <div class="nmodal-actions">
                    <button type="button" class="nbtn" onClick={() => setDialog(null)}>
                      取消
                    </button>
                    <button
                      type="button"
                      class="nbtn danger"
                      disabled={dialogBusy()}
                      onClick={() => void submitDelete()}
                    >
                      删除
                    </button>
                  </div>
                </Match>

                {/* 未保存确认 */}
                <Match when={discardDialog()}>
                  <div class="nmodal-head">
                    <span>未保存的修改</span>
                    <button type="button" class="nmodal-close" onClick={() => setDialog(null)}>
                      ×
                    </button>
                  </div>
                  <div class="nmodal-body">
                    <div class="nmodal-text">{discardDialog()!.message}</div>
                  </div>
                  <div class="nmodal-actions">
                    <button type="button" class="nbtn" onClick={() => setDialog(null)}>
                      取消
                    </button>
                    <button type="button" class="nbtn" disabled={dialogBusy()} onClick={() => void submitDiscard(false)}>
                      放弃修改
                    </button>
                    <button
                      type="button"
                      class="nbtn primary"
                      disabled={dialogBusy()}
                      onClick={() => void submitDiscard(true)}
                    >
                      保存并继续
                    </button>
                  </div>
                </Match>
              </Switch>
            </div>
          </div>
        </Show>

        {/* ── 搜索文件（图3） ── */}
        <Show when={showSearch()}>
          <SearchDialog
            onClose={() => setShowSearch(false)}
            onOpenFile={(path, line) => {
              const node = findNodeByPath(tree(), path);
              if (node) openFile(node, line);
            }}
          />
        </Show>
      </div>
    </PopupFrame>
  );
};
