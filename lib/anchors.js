// ============================================================================
// lib/anchors.js —— 项目级"实例锚点"约定(A1, v0.7.0)
// ----------------------------------------------------------------------------
// 动机(反馈 §二.2): 目标机的 instance_id / region 只存在于会话记录里, 换一个
// 会话就要重新"猜地域"(§二.1)。于是约定一个**项目级文件**, 由**插件定义格式、
// 由项目填内容**(与 runbook 同一条原则):
//
//   工作区 .dsh/workbench-ecs/instances.json
//   {
//     "prod":    { "instance_id": "i-uf66ct2o35p7fjcd0sru", "region": "cn-shanghai", "repo": "/root/app" },
//     "staging": { "instance_id": "i-bp1xxxx", "region": "cn-hangzhou", "note": "预发" }
//   }
//
// 两个作用:
//   1. 工具参数 instance_id 可以直接写**锚点名**(如 "prod"): 插件在工具注册边界
//      统一解析成真实 instance_id, 并补齐缺省的 region —— 各工具零改动;
//   2. 锚点里除 instance_id/region 之外的字段(如 repo)成为 **runbook 隐式参数**,
//      于是跑书里的 ${repo} 不必每次手传。
//
// 向后兼容: 没有该文件时行为与从前完全一致; 文件损坏时降级为"按原值下发"(不阻断)。
// ============================================================================
import { omitUndefined, resolveWorkspaceRoot } from './common.js'

// 相对会话工作区的锚点文件
export const INSTANCES_FILE = '.dsh/workbench-ecs/instances.json'
// 锚点名白名单(会被当作 JSON 的键, 因此只做形状约束, 不做路径拼接)
export const ANCHOR_NAME_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/
// 真实 ECS 实例 ID 形状: i- 开头 + 小写字母数字
export const INSTANCE_ID_RE = /^i-[0-9a-z]+$/i

export function isInstanceIdLike(value) {
  return INSTANCE_ID_RE.test(String(value != null ? value : '').trim())
}

export function isAnchorNameLike(value) {
  const v = String(value != null ? value : '').trim()
  return v.length > 0 && !isInstanceIdLike(v) && ANCHOR_NAME_RE.test(v)
}

// 锚点文件路径(与 runbook 目录同源: 会话工作区优先)
export function instancesPathOf(opts = {}) {
  const direct = opts.instancesPath !== undefined && opts.instancesPath !== null ? String(opts.instancesPath).trim() : ''
  if (direct.length > 0) return direct
  const rootRaw = opts.workspaceRoot !== undefined && opts.workspaceRoot !== null ? String(opts.workspaceRoot) : ''
  const root = rootRaw.replace(/[\\/]+$/, '')
  return (root.length > 0 ? root + '/' : '') + INSTANCES_FILE
}

// 读取锚点集合: 文件不存在/无 fs/JSON 非法都**不抛错**, 而是返回 ok:false + 原因,
// 由调用方决定降级策略(工具侧: 按原值下发; 面板/ecs_find: 如实展示)。
export async function loadAnchors(ctx, opts = {}) {
  const path = instancesPathOf(opts)
  const fs = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('fs') : undefined
  if (fs === undefined || fs === null) {
    return { ok: false, reason: 'no-fs', path, anchors: {}, names: [] }
  }
  let target
  try {
    target = await fs.resolve(path, opts.signal !== undefined ? { signal: opts.signal } : undefined)
  } catch (err) {
    return { ok: false, reason: 'resolve-failed', path, anchors: {}, names: [], error: errText(err) }
  }
  let text
  try {
    text = await fs.readText(target, opts.signal)
  } catch (err) {
    // 文件不存在是最常见的正常情况: 明确区分, 便于调用方给"如何创建"的提示
    const message = errText(err)
    return {
      ok: false,
      reason: /ENOENT|no such file|not found/i.test(message) ? 'missing' : 'read-failed',
      path, anchors: {}, names: [], error: message,
    }
  }
  let data
  try {
    data = JSON.parse(String(text))
  } catch (err) {
    return { ok: false, reason: 'invalid-json', path, anchors: {}, names: [], error: errText(err) }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'invalid-shape', path, anchors: {}, names: [], error: '顶层必须是对象 { "<锚点名>": { instance_id, region, ... } }' }
  }
  const anchors = {}
  const invalid = []
  for (const key of Object.keys(data)) {
    // 以 "//" 或 "_" 开头的键视为注释(JSON 里写注释的常见约定), 不计入锚点也不算错误
    if (key.startsWith('//') || key.startsWith('_')) continue
    const entry = data[key]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid.push(key)
      continue
    }
    const instanceId = entry.instance_id !== undefined ? String(entry.instance_id).trim() : ''
    if (instanceId.length === 0) {
      invalid.push(key)
      continue
    }
    const rest = {}
    for (const field of Object.keys(entry)) {
      if (field === 'instance_id' || field === 'region') continue
      rest[field] = entry[field]
    }
    anchors[key] = omitUndefined({
      name: key,
      instance_id: instanceId,
      region: entry.region !== undefined && entry.region !== null && String(entry.region).length > 0
        ? String(entry.region)
        : undefined,
      fields: rest,
    })
  }
  return {
    ok: true,
    path,
    anchors,
    names: Object.keys(anchors).sort(),
    invalid: invalid.length > 0 ? invalid : undefined,
  }
}

function errText(err) {
  return err && err.message !== undefined ? String(err.message) : String(err)
}

// 解析单个锚点名。三种结果:
//   { anchor }        命中
//   undefined         文件不存在/不可读(调用方按原值下发, 保持向后兼容)
//   throw             文件存在但没有这个锚点 —— 报错并列出可用名字(比交给 CLI 报错更有用)
export async function resolveAnchor(ctx, name, opts = {}) {
  const loaded = await loadAnchors(ctx, opts)
  if (loaded.ok !== true) return { loaded, anchor: undefined }
  const anchor = loaded.anchors[name]
  if (anchor !== undefined) return { loaded, anchor }
  throw new Error('未找到实例锚点 "' + name + '"(' + loaded.path + ')' +
    (loaded.names.length > 0
      ? '; 可用的锚点: ' + loaded.names.join(', ')
      : '; 该文件里还没有任何锚点') +
    '。实例锚点约定: 在 ' + INSTANCES_FILE + ' 里写 {"' + name + '": {"instance_id": "i-xxx", "region": "cn-shanghai"}}')
}

// ----------------------------------------------------------------------------
// 工具注册边界的锚点解析: 把 args.instance_id / args.instance_ids 里的锚点名
// 换成真实 instance_id, 并在 region 缺省时用锚点的 region 补齐。
// 返回新对象(不改动入参), 并把锚点信息挂在 WeakMap 上供 runbook 隐式参数使用。
// ----------------------------------------------------------------------------
const anchorInfoByArgs = new WeakMap()

export function setAnchorInfo(args, info) {
  if (args !== null && typeof args === 'object' && info !== undefined && info !== null) anchorInfoByArgs.set(args, info)
}

// 读取某次调用解析出的锚点信息(ecs_deploy/ecs_runbook 用它补隐式参数)
export function anchorInfoOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  return anchorInfoByArgs.get(args)
}

// 锚点字段 → runbook 隐式参数(instance_id/region 之外的项目字段)
export function anchorImplicitParams(info) {
  if (info === undefined || info === null) return {}
  const fields = info.fields !== undefined && info.fields !== null && typeof info.fields === 'object' ? info.fields : {}
  return Object.assign({}, fields)
}

export async function resolveAnchorsInArgs(ctx, args, exec) {
  if (args === null || typeof args !== 'object') return { args, anchor: undefined }
  const single = args.instance_id !== undefined && args.instance_id !== null ? String(args.instance_id).trim() : ''
  const many = Array.isArray(args.instance_ids) ? args.instance_ids.map((id) => String(id).trim()) : undefined
  const singleIsName = single.length > 0 && isAnchorNameLike(single)
  const manyHasName = many !== undefined && many.some((id) => id.length > 0 && isAnchorNameLike(id))
  if (!singleIsName && !manyHasName) return { args, anchor: undefined }

  const workspaceRoot = resolveWorkspaceRoot(ctx, exec)
  let loaded
  let anchor
  if (singleIsName) {
    // 文件不存在 → loaded.ok=false(下面原样下发); 文件存在但没这个名字 → resolveAnchor 直接抛错
    const resolved = await resolveAnchor(ctx, single, { workspaceRoot })
    loaded = resolved.loaded
    anchor = resolved.anchor
  } else {
    // 批量: 逐个解析(可能有多个不同锚点), region 取第一个命中的锚点
    for (const candidate of many) {
      if (!isAnchorNameLike(candidate)) continue
      const resolved = await resolveAnchor(ctx, candidate, { workspaceRoot })
      loaded = resolved.loaded
      if (resolved.anchor !== undefined) anchor = resolved.anchor
    }
  }
  if (loaded === undefined || loaded.ok !== true) {
    // 没有锚点文件(或不可读) → 原样下发, 与旧行为一致
    return { args, anchor: undefined }
  }

  const next = Object.assign({}, args)
  if (singleIsName) {
    next.instance_id = anchor.instance_id
    if (anchor.region !== undefined && (args.region === undefined || args.region === null || String(args.region).length === 0)) {
      next.region = anchor.region
    }
  }
  if (manyHasName) {
    const replaced = []
    for (const id of many) {
      if (!isAnchorNameLike(id)) {
        replaced.push(id)
        continue
      }
      const found = loaded.anchors[id]
      if (found === undefined) throw anchorNotFound(id, loaded)
      replaced.push(found.instance_id)
    }
    next.instance_ids = replaced
    if (anchor !== undefined && anchor.region !== undefined &&
        (args.region === undefined || args.region === null || String(args.region).length === 0)) {
      next.region = anchor.region
    }
  }
  setAnchorInfo(next, anchor)
  return { args: next, anchor }
}

function anchorNotFound(name, loaded) {
  return new Error('未找到实例锚点 "' + name + '"(' + loaded.path + ')' +
    (loaded.names.length > 0 ? '; 可用的锚点: ' + loaded.names.join(', ') : '; 该文件里还没有任何锚点') +
    '。实例锚点约定: 在 ' + INSTANCES_FILE + ' 里写 {"' + name + '": {"instance_id": "i-xxx", "region": "cn-shanghai"}}')
}
