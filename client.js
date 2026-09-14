// dsh-updater client half — single hand-written file, zero build, zero deps.
//
// CLASSIC SCRIPT: client bundles are evaluated as classic scripts by the host — no ESM syntax.
//
// Layout (controller amendment: the runtime module system has no relative-require
// branch — makeRequire resolves only seed words, materialized package rows and
// registered factories, so view-model/poller/page MUST all live inline here):
//
//   1. Pure logic (this top section): `toViewModel`, `nextDelayMs`,
//      `createPoller` — top-level function declarations (a classic script has
//      no exports); test/*.test.js reach them by running this file in a fresh
//      vm context (test/helpers/client-bundle.js).
//   2. Browser half (bottom section): guarded by
//      `if (typeof window !== 'undefined' && window.__ModuleLoader__)` —
//      registers the Settings page via the host module loader. The guard is
//      false under Node, which is what keeps (1) side-effect-free and testable.

// ---------------------------------------------------------------------------
// 1. Pure logic
// ---------------------------------------------------------------------------

// 快照 → 视图模型。纯函数:不碰 DOM、不碰网络,方便 node:test。
const TONE = { 'up-to-date': 'ok', behind: 'behind', diverged: 'diverged', error: 'error', 'no-upstream': 'error' }

function toViewModel(snapshot) {
  const update = snapshot?.update ?? {}
  const checks = snapshot?.checks ?? []
  const pills = checks.map(c => {
    const isHarness = c.kind === 'harness-git'
    // 集成 pill 用末两段路径段当短名(/a/b/c/d → c/d),全路径进 title 供原生
    // tooltip;不足两段(含 0 段)回退为 target 本身。harness 保持固定短名。
    const segs = isHarness ? [] : String(c.target ?? '').split('/').filter(Boolean)
    return {
      name: isHarness ? 'harness' : (segs.length >= 2 ? segs.slice(-2).join('/') : (c.target ?? c.kind)),
      detail: c.status === 'behind' ? `behind ${c.behindCount}` : (c.status === 'error' ? (c.error ?? 'error') : c.status),
      tone: TONE[c.status] ?? 'error',
      title: isHarness ? undefined : c.target,
    }
  })
  const running = Boolean(update.running)
  const last = update.lastResult
  const steps = last?.harness?.steps ?? []
  return {
    pills,
    running,
    // diverged 也算"可发起更新":服务端 buildPlan 对 diverged-only 会以
    // value(skipped/refusal)拒绝而不是报错,按钮可点、语义安全(brief Step 4
    // 授权按断言微调实现)。
    canUpdate: !running && checks.some(c => c.status === 'behind' || c.status === 'diverged'),
    canCancel: running,
    banner: update.pendingRestart ? 'update applied — restart dsh to load the new build' : undefined,
    steps: running ? (update.log ?? []) : steps,
    lastReason: last ? (last.ok ? 'ok' : (last.cancelled ? 'cancelled' : 'failed')) : undefined,
  }
}

// 轮询节流:running 快轮、idle 慢轮。timer 注入,node:test 手动驱动。
function nextDelayMs(running, runningMs = 5000, idleMs = 30000) {
  return running ? runningMs : idleMs
}

function createPoller({ fetch, apply, setTimer, clearTimer, runningMs = 5000, idleMs = 30000 }) {
  let timer = null
  let stopped = true
  async function tick() {
    timer = null
    let running = false
    try {
      const value = await fetch()
      running = Boolean(value?.update?.running)
      apply(value)
    } catch { /* RPC 不可达:保持节奏,下轮再试;apply 不被调用,页面沿用上次视图 */ }
    if (!stopped) schedule(running)
  }
  function schedule(running) {
    timer = setTimer(() => { void tick() }, nextDelayMs(running, runningMs, idleMs))
  }
  return {
    start() {
      if (!stopped) return
      stopped = false
      void tick()
    },
    stop() {
      stopped = true
      if (timer) { clearTimer(timer); timer = null }
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Browser half — Settings page registration(guard 挡住 Node;永不副作用)
// ---------------------------------------------------------------------------

const NS = 'dsh-updater'

const DICT = {
  zh: {
    title: '软件更新',
    check: '检查更新',
    update: '一键更新',
    cancel: '取消',
    banner: '更新已应用——重启 dsh 以加载新版本',
    error: '状态获取失败',
    retry: '重试',
    idle: '空闲',
    running: '更新中…',
    lastUpdate: '上次更新',
    failed: '失败',
    cancelled: '已取消',
    uptodate: '已检查：全部为最新',
    nav: '更新',
    checking: '检查中…',
    starting: '启动中…',
  },
  en: {
    title: 'Software updates',
    check: 'Check for updates',
    update: 'Update now',
    cancel: 'Cancel',
    banner: 'Update applied — restart dsh to load the new build',
    error: 'Failed to fetch status',
    retry: 'Retry',
    idle: 'Idle',
    running: 'Updating…',
    lastUpdate: 'Last update',
    failed: 'Failed',
    cancelled: 'Cancelled',
    uptodate: 'checked — everything up to date',
    nav: 'Updates',
    checking: 'Checking…',
    starting: 'Starting…',
  },
}

// tone → 主题色。全部走宿主 design token(--dsw-alias-*),自动适配明暗主题。
const PILL_COLOR = {
  ok: 'var(--dsw-alias-state-success-primary)',
  behind: 'var(--dsw-alias-state-warn-primary)',
  diverged: 'var(--dsw-alias-state-business-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
}

// 极小 pub/sub:模块级 poller 与 React 组件之间的状态桥(set 为浅合并)。
function createStore(initial) {
  let state = initial
  const listeners = new Set()
  return {
    get: () => state,
    set(patch) { state = { ...state, ...patch }; for (const l of [...listeners]) l(state) },
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l) } },
  }
}

function h(createElement, tag, style, props, ...children) {
  // props 位只认无 type 的普通对象;字符串/元素孩子不算 props,避免手写调用点错位。
  const isProps = props !== null && props !== undefined && typeof props === 'object' && !('type' in props)
  const kids = isProps ? children : [props, ...children]
  return createElement(tag, { ...(isProps ? props : {}), style }, ...kids.filter(c => c !== undefined && c !== null && c !== false))
}

function renderPills(hh, vm) {
  return hh('div', { display: 'flex', flexWrap: 'wrap', gap: 8 },
    ...vm.pills.map((p, i) => hh('span', {
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '2px 10px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)',
    }, { key: i, ...(p.title ? { title: p.title } : {}) },
      hh('span', { width: 8, height: 8, borderRadius: '50%', background: PILL_COLOR[p.tone] ?? PILL_COLOR.error }),
      hh('span', { fontSize: 12, color: 'var(--dsw-alias-label-primary)' }, `${p.name} · ${p.detail}`))))
}

// 上下文按钮:running 只给 Cancel;空闲给 Check(+可更新时 Update now)。
// 渲染出来的按钮永远可点,唯一的状态效果是 busyEndpoint 命中者换文案
// (acceptance #3:可见即可用,禁用态不再假装按钮死了)。
function renderButtons(hh, tt, vm, busyEndpoint, onAction) {
  const defs = vm.running
    ? [{ endpoint: 'cancel', label: tt('cancel') }]
    : [
        { endpoint: 'get-status', label: busyEndpoint === 'get-status' ? tt('checking') : tt('check') },
        ...(vm.canUpdate ? [{ endpoint: 'start-update', label: busyEndpoint === 'start-update' ? tt('starting') : tt('update') }] : []),
      ]
  return hh('div', { display: 'flex', gap: 8 }, ...defs.map(d => hh('button', {
    padding: '4px 14px', borderRadius: 6, cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
  }, { key: d.endpoint, onClick: () => onAction(d.endpoint) }, d.label)))
}

function renderSteps(hh, vm) {
  if (!vm.steps.length) return null
  return hh('div', { display: 'grid', gap: 2, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
    ...vm.steps.map((s, i) => hh('div', undefined, { key: i },
      [s.target, s.step, s.status, s.detail ?? s.error].filter(Boolean).join(' · '))))
}

// 注册 Settings 页 + 启动轮询。任何服务缺失/异常 → console.info 自禁用,不抛。
function mount(ctx, react) {
  try {
    const { createElement, useState, useEffect } = react
    const hh = (...args) => h(createElement, ...args)
    ctx.locale.register(NS, DICT)
    const t = ctx.locale.bind(NS)
    const store = createStore({ snapshot: null, error: null, note: null })

    // rpc.call 返回 {ok:true,value}|{ok:false,error} 信封;解包,协议拒绝与传输
    // 失败统一变成 throw。走共享 /api 通道 + `dsh-updater.` 前缀端点名,而不是
    // 独立通道 '/dsh-updater':host 侧的 connection.rpc.handle 在 harness 里是坏的
    // (见 lib/rpc-routes.js 顶注),独立通道根本挂不上路由。
    const call = async (endpoint) => {
      const r = await ctx.connection.rpc.call('/api', `${NS}.${endpoint}`, {})
      if (!r || r.ok !== true) throw new Error(r?.error?.message ?? 'rpc unavailable')
      return r.value
    }

    // fetch 失败:把 error 写进 store(保留上次视图)后重抛——poller 吞掉并保持
    // 节奏,apply 不被调用;成功路径由 apply 清 error。setTimer/clearTimer 用真定时器。
    const poller = createPoller({
      fetch: async () => {
        try { return await call('get-status') } catch (e) {
          store.set({ error: e?.message ?? String(e) })
          throw e
        }
      },
      apply: (snapshot) => store.set({ snapshot, error: null }),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    })
    const refresh = () => { poller.stop(); poller.start() }

    const Section = (props) => {
      const tt = props?.t ?? t
      const [state, setState] = useState(store.get)
      useEffect(() => store.subscribe(() => setState(store.get())), [])
      // 轮询生命周期挂在组件挂载上:只在真正渲染本页时轮询、卸载即停,
      // 其他 web 窗口不再空转触发 30s 轮询。start 幂等(createPoller 守卫)。
      useEffect(() => {
        poller.start()
        return () => poller.stop()
      }, [])
      // busyEndpoint(而非布尔):只有被点的那颗按钮换文案,其他按钮是独立
      // 动作、保持正常可点。
      const [busyEndpoint, setBusyEndpoint] = useState(null)
      const [note, setNote] = useState(null)
      const vm = toViewModel(state.snapshot)
      const onAction = async (endpoint) => {
        setBusyEndpoint(endpoint)
        // 即时反馈先于 await:点击立刻有文字变化;cancel 不预写 note——
        // running 视图消失本身就是反馈。
        if (endpoint === 'get-status') setNote(tt('checking'))
        if (endpoint === 'start-update') setNote(tt('starting'))
        try {
          const v = await call(endpoint)
          if (endpoint === 'get-status') setNote(tt('uptodate'))       // 快照 value 上没有 reason/note,成功也要给可见反馈
          else if (endpoint === 'start-update') setNote(v?.reason ?? v?.note ?? tt('starting'))   // refusal 显示 reason;真启动则维持「启动中」,running 视图随 refresh 接管
          else setNote(v?.reason ?? v?.note ?? null)                   // cancel:refusal/note 是 value 不是 error
        } catch (e) {
          setNote(String(e?.message ?? e))
        } finally {
          setBusyEndpoint(null)
          refresh()
        }
      }
      const line = state.error ?? note
      return hh('div', { display: 'grid', gap: 10, padding: '12px 0' },
        vm.banner && hh('div', {
          padding: '8px 12px', borderRadius: 8, fontSize: 13,
          color: 'var(--dsw-alias-state-warn-label)', border: '1px solid var(--dsw-alias-state-warn-primary)',
        }, tt('banner')),
        hh('div', { display: 'flex', alignItems: 'center', gap: 8 },
          hh('span', { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }, tt('title')),
          hh('span', { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }, vm.running ? tt('running') : tt('idle'))),
        renderPills(hh, vm),
        renderButtons(hh, tt, vm, busyEndpoint, onAction),
        renderSteps(hh, vm),
        // 上次更新结果(failed/cancelled)常驻展示,别只活在一次性 note 里
        vm.lastReason && vm.lastReason !== 'ok' && hh('div', {
          fontSize: 12,
          color: vm.lastReason === 'failed'
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-secondary)',
        }, `${tt('lastUpdate')}: ${tt(vm.lastReason)}`),
        line && hh('div', { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
          hh('span', {
            color: state.error
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-secondary)',
          }, state.error ? `${tt('error')}: ${state.error}` : line),
          state.error && hh('button', {
            padding: '2px 10px', borderRadius: 6, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
          }, { onClick: refresh }, tt('retry'))))
    }

    // 清理先行注册:先于任何 poller.start()(含 Section useEffect 里的那次),
    // 杜绝「已 start、尚未注册 stop 回调」窗口内抛错导致的孤儿轮询。
    ctx.effect(() => () => poller.stop(), 'dsh-updater: stop status poller')

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: 'dsh-updater', order: 100,
      label: () => t('nav'), locale: NS,
    }, Section))
  } catch (reason) {
    console.info('[dsh-updater] client half disabled:', reason)
  }
}

// factory:运行时 require 只认 seed 字('react' 在 platform seed 里,spike Q3)。
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: 'dsh-updater',
    factory: (require) => {
      const react = require('react')
      return { inject: ['slots', 'locale', 'connection'], apply: (ctx) => mount(ctx, react) }
    },
  })
}
