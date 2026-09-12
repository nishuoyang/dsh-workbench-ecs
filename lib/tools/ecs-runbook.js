// ============================================================================
// lib/tools/ecs-runbook.js —— ecs_runbook: 工作区发布跑书的**只读**清点与校验
// ----------------------------------------------------------------------------
// 动机(v0.6.3): runbook 是纯数据, 因此"哪里写错了"完全可以在下发任何命令之前
// 全部查清。此前只能靠真跑一遍去撞(缺参数、字段笔误、assert 没有判据、
// read_only 与命令矛盾……都要等执行时才报, 且一次只报第一条)。
//
// 三个动作, 全部零远程调用(不触达 ECS 实例, 不需要 instance_id):
//   list     —— 列出工作区 runbook: 名称/说明/步数/类型/参数占位 + 校验结论;
//   validate —— 对某一份 runbook 做静态校验, 逐条给出 error/warn 与定位;
//   plan     —— 校验通过后按参数展开成计划(回显将要执行的命令, 不执行)。
//
// 校验复用**执行期的同一份结构校验**(steps-engine.planSteps), 因此 lint 的
// 文案与真正执行时的报错逐字一致 —— 不会出现"lint 说没事、跑起来才炸"。
// ============================================================================
import { omitUndefined, resolveWorkspaceRoot } from '../common.js'
import {
  RUNBOOK_DIR, listRunbookNames, loadRunbook, lintRunbook, parseRunbook, buildRunbookRun,
  summarizeRunbook, runbookDirOf,
} from '../runbooks.js'
import { planSteps, STEPS_STAGE_TIMEOUT } from '../steps-engine.js'

const RUNBOOK_ACTIONS = ['list', 'validate', 'plan']

export function ecsRunbookDefinition(ctx) {
  // list 视图里"缺参数"不算问题(是否缺取决于本次要传什么), 因此单独过滤:
  // 想看清参数是否齐备请用 validate / plan。
  function structuralIssues(lint) {
    return (lint.issues !== undefined ? lint.issues : []).filter((i) => i.code !== 'missing_param')
  }

  // 跑书目录 = 会话工作区 + RUNBOOK_DIR(v0.6.4 / D11): 与 DSH 内置工具同源
  // (exec.agent.session.header.cwd), 不再取部署兜底的 process.cwd()。
  function runbookBase(exec) {
    const workspaceRoot = resolveWorkspaceRoot(ctx, exec)
    return { workspaceRoot, dir: runbookDirOf({ workspaceRoot }) }
  }

  async function listRunbooks(exec) {
    const base = runbookBase(exec)
    const workspaceRoot = base.workspaceRoot
    const names = await listRunbookNames(ctx, { workspaceRoot, signal: exec.signal })
    const dir = base.dir
    const entries = []
    for (const name of names) {
      try {
        const loaded = await loadRunbook(ctx, name, { workspaceRoot, signal: exec.signal })
        const lint = lintRunbook(loaded.text, { name })
        const runbook = lint.summary !== undefined
          ? parseRunbook(loaded.text, 'runbook ' + name)
          : undefined
        const shape = runbook !== undefined ? summarizeRunbook(runbook) : undefined
        const structural = structuralIssues(lint)
        entries.push(omitUndefined({
          name,
          path: loaded.path,
          description: runbook !== undefined ? runbook.description : undefined,
          display_name: runbook !== undefined ? runbook.name : undefined,
          step_count: shape !== undefined ? shape.step_count : undefined,
          kinds: shape !== undefined ? shape.kinds.map((k) => k.kind + '×' + k.count) : undefined,
          declared_params: shape !== undefined ? shape.declared_params : undefined,
          defaults: shape !== undefined ? Object.keys(shape.params).sort() : undefined,
          ok: structural.every((i) => i.level !== 'error'),
          error_count: structural.filter((i) => i.level === 'error').length,
          warn_count: structural.filter((i) => i.level === 'warn').length,
          first_issue: structural.length > 0 ? structural[0].message : undefined,
        }))
      } catch (err) {
        entries.push({ name, ok: false, error_count: 1, warn_count: 0, first_issue: String(err != null && err.message != null ? err.message : err) })
      }
    }
    return { action: 'list', ok: true, dir, count: entries.length, runbooks: entries, command_line: 'workbench (无) — 本次未调用任何 CLI 命令' }
  }

  async function loadForValidate(args, exec) {
    const workspaceRoot = resolveWorkspaceRoot(ctx, exec)
    const raw = args.runbook
    if (typeof raw === 'string' && raw.length > 0) {
      const loaded = await loadRunbook(ctx, raw, { workspaceRoot, signal: exec.signal })
      return { text: loaded.text, path: loaded.path, source: 'workspace', name: raw }
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return { text: JSON.stringify(raw), path: undefined, source: 'inline', name: raw.name !== undefined ? String(raw.name) : '(内联)' }
    }
    throw new Error('ecs_runbook: runbook 必须是名字字符串(读工作区 ' + RUNBOOK_DIR +
      '/<name>.json)或内联对象 { params?, steps }')
  }

  async function validate(args, exec) {
    const loaded = await loadForValidate(args, exec)
    const lint = lintRunbook(loaded.text, {
      name: loaded.name,
      params: args.runbook_params,
      instance_id: args.instance_id,
      region: args.region,
      timeout: args.timeout,
    })
    return omitUndefined(Object.assign({ action: 'validate', path: loaded.path, source: loaded.source }, lint))
  }

  async function plan(args, exec) {
    const loaded = await loadForValidate(args, exec)
    const lint = lintRunbook(loaded.text, {
      name: loaded.name, params: args.runbook_params, instance_id: args.instance_id, region: args.region, timeout: args.timeout,
    })
    if (lint.summary === undefined) {
      // 解析失败(JSON/形状错误): 直接把问题回给模型, 不进入展开阶段
      return omitUndefined({ action: 'plan', ok: false, path: loaded.path, source: loaded.source, issues: lint.issues, error_count: lint.error_count, warn_count: lint.warn_count })
    }
    const parseArgs = {
      instance_id: args.instance_id !== undefined && args.instance_id !== null && String(args.instance_id).length > 0
        ? String(args.instance_id) : '<instance_id>',
      region: args.region,
      timeout: args.timeout,
      read_only: args.read_only,
    }
    // 参数展开(与执行同源): 展开后若还有未替换占位符, 直接按缺参数报出
    const runbook = parseRunbook(loaded.text, 'runbook ' + loaded.name)
    const run = buildRunbookRun(runbook, args.runbook_params, {
      instance_id: args.instance_id, region: args.region,
    })
    if (run.missing.length > 0) {
      return omitUndefined({
        action: 'plan', ok: false, path: loaded.path, source: loaded.source,
        missing_params: run.missing, declared_params: run.declared,
        issues: lint.issues, error_count: lint.error_count, warn_count: lint.warn_count,
        error: 'runbook ' + loaded.name + ' 缺少参数: ' + run.missing.join(', '),
      })
    }
    const stepPlan = planSteps(run.steps, parseArgs)
    return omitUndefined({
      action: 'plan',
      ok: true,
      runbook: loaded.name,
      path: loaded.path,
      source: loaded.source,
      description: runbook.description,
      resolved_params: run.params,
      declared_params: run.declared.length > 0 ? run.declared : undefined,
      unused_params: run.unused.length > 0 ? run.unused : undefined,
      total_stage: stepPlan.length,
      plan: stepPlan.map((s) => omitUndefined({
        index: s.index, kind: s.kind, name: s.name, timeout: Number(s.timeout),
        command_line: s.command_line,
        read_only: s.read_only === true ? true : undefined,
        verify_sha256: s.kind === 'upload' ? s.verify : undefined,
      })),
      issues: lint.issues,
      error_count: lint.error_count,
      warn_count: lint.warn_count,
      command_line: 'workbench (无) — 预演不执行任何命令',
    })
  }

  return {
    name: 'ecs_runbook',
    description: '只读地清点与校验工作区的发布跑书(Runbook)。runbook 是**纯数据**(步骤 + 断言 + ${参数} 占位), ' +
      '放在工作区 ' + RUNBOOK_DIR + '/<name>.json; 本工具**不触达任何 ECS 实例**, 也不需要 instance_id。' +
      'action: list = 列出全部 runbook 及其校验结论; validate = 对某一份逐条给出静态校验问题(error/warn, ' +
      '含缺失参数、字段笔误、assert 无判据、read_only 与命令矛盾、破坏性命令、tail 只读一次等); ' +
      'plan = 按参数展开成计划并回显将要执行的命令(不执行、不请求审批)。' +
      '建议在 ecs_deploy { runbook } 之前先 validate —— runbook 是纯数据, 写错了完全可以在下发任何命令之前查清。' +
      '注意 shell 变量要写 $${NAME} 转义, 否则会被当作 runbook 占位符。',
    parameters: {
      action: { type: 'string', required: true, enum: RUNBOOK_ACTIONS, description: 'list / validate / plan' },
      runbook: { type: 'json', description: 'validate / plan 必填: "名字" → 读工作区 ' + RUNBOOK_DIR + '/<name>.json; 或内联对象 { params?, steps }' },
      runbook_params: { type: 'json', description: '可选: 参数对象, 覆盖 runbook 的 params 默认值并替换 ${占位符}; 隐式可用 instance_id / region' },
      instance_id: { type: 'string', description: '可选: plan 时用于替换隐式 ${instance_id} 并展示目标(argv 里出现); 缺省时显示为 <instance_id>' },
      region: { type: 'string', description: '可选: plan 时附加到步骤命令行' },
      timeout: { type: 'integer', description: '可选: plan 时假定的每步超时(秒), 默认 ' + STEPS_STAGE_TIMEOUT },
      read_only: { type: 'boolean', description: '可选: plan 时按只读护栏口径预检(与 ecs_deploy read_only 一致)' },
    },
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          dir: { type: 'string' },
          count: { type: 'integer' },
          runbook: { type: 'string' },
          path: { type: 'string' },
          source: { type: 'string' },
          description: { type: 'string' },
          error: { type: 'string' },
          name: { type: 'string' },
          summary: { type: 'json' },
          declared_params: { type: 'array', items: { type: 'string' } },
          missing_params: { type: 'array', items: { type: 'string' } },
          resolved_params: { type: 'json' },
          unused_params: { type: 'array', items: { type: 'string' } },
          error_count: { type: 'integer' },
          warn_count: { type: 'integer' },
          total_stage: { type: 'integer' },
          runbooks: { type: 'array', items: { type: 'json' } },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                level: { type: 'string' },
                code: { type: 'string' },
                message: { type: 'string' },
                step: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          plan: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                kind: { type: 'string' },
                name: { type: 'string' },
                timeout: { type: 'integer' },
                command_line: { type: 'string' },
                read_only: { type: 'boolean' },
                verify_sha256: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = []
        if (value.action === 'list') {
          lines.push('工作区 runbook — ' + value.dir + ' (共 ' + value.count + ' 份)')
          if (value.count === 0) {
            lines.push('')
            lines.push('未发现 runbook: 在工作区 ' + RUNBOOK_DIR + '/ 下放置 <name>.json 即可(纯数据: steps + 断言 + ${参数})。')
          }
          for (const item of value.runbooks) {
            const head = (item.ok === true ? '✔ ' : '✘ ') + item.name +
              (item.description !== undefined ? ' — ' + item.description : '')
            lines.push('')
            lines.push(head)
            if (item.step_count !== undefined) {
              lines.push('    ' + item.step_count + ' 步 (' + (item.kinds !== undefined ? item.kinds.join(' ') : '') + ')' +
                (item.declared_params !== undefined && item.declared_params.length > 0
                  ? ' · 参数占位: ' + item.declared_params.map((p) => '${' + p + '}').join(' ') : ''))
            }
            if (item.error_count > 0 || item.warn_count > 0) {
              lines.push('    校验: ' + item.error_count + ' 个错误, ' + item.warn_count + ' 个提醒' +
                (item.first_issue !== undefined ? ' — ' + item.first_issue : ''))
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }

        const title = (value.action === 'plan' ? 'Runbook 预演' : 'Runbook 校验') + ' — ' +
          (value.runbook !== undefined ? value.runbook : (value.name !== undefined ? value.name : '(未命名)')) +
          (value.path !== undefined ? ' [' + value.path + ']' : (value.source === 'inline' ? ' [内联]' : ''))
        lines.push(title)
        if (value.summary !== undefined) {
          lines.push('  ' + value.summary.step_count + ' 步 (' +
            value.summary.kinds.map((k) => k.kind + '×' + k.count).join(' ') + ')' +
            (value.declared_params !== undefined && value.declared_params.length > 0
              ? ' · 参数占位: ' + value.declared_params.map((p) => '${' + p + '}').join(' ') : ''))
        }
        if (value.error !== undefined) lines.push('  错误: ' + value.error)
        const issues = value.issues !== undefined ? value.issues : []
        if (issues.length > 0) {
          lines.push('')
          for (const issue of issues) {
            lines.push('  ' + (issue.level === 'error' ? '✘ [错误] ' : '⚠ [提醒] ') +
              (issue.step !== undefined ? 'steps[' + issue.step + '] ' : '') + issue.message)
          }
        }
        const errors = value.error_count !== undefined ? value.error_count : 0
        const warns = value.warn_count !== undefined ? value.warn_count : 0
        lines.push('')
        lines.push(errors === 0 && warns === 0
          ? '结论: 未发现问题。'
          : '结论: ' + errors + ' 个错误, ' + warns + ' 个提醒' + (errors === 0 ? '(可以执行)' : '(请先修复错误)'))
        if (value.action === 'plan' && value.ok === true) {
          lines.push('')
          lines.push('计划(未执行任何命令; 去掉预演用 ecs_deploy { runbook, runbook_params } 执行):')
          for (const step of value.plan) {
            lines.push('')
            lines.push('[' + step.index + '] ' + step.kind + ' · ' + step.name + '  (timeout ' + step.timeout + 's)')
            lines.push('  $ ' + step.command_line)
            if (step.read_only === true) lines.push('  [read_only]')
            if (step.verify_sha256 === true) lines.push('  [上传后校验 sha256]')
          }
        }
        if (value.missing_params !== undefined && value.missing_params.length > 0) {
          lines.push('')
          lines.push('缺少参数: ' + value.missing_params.join(', ') +
            '(该 runbook 声明的占位符: ' + (value.declared_params !== undefined && value.declared_params.length > 0
              ? value.declared_params.join(', ') : '(无)') + ')')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (args, value) => omitUndefined({
        action: value.action,
        ok: value.ok,
        runbook: value.runbook !== undefined ? value.runbook : value.name,
        error_count: value.error_count,
        warn_count: value.warn_count,
        count: value.count,
        total_stage: value.total_stage,
      }),
    },
    async execute(args, exec) {
      const action = args.action !== undefined ? String(args.action) : ''
      if (!RUNBOOK_ACTIONS.includes(action)) {
        throw new Error('ecs_runbook: action 非法: ' + action + '(应为 ' + RUNBOOK_ACTIONS.join(' / ') + ')')
      }
      if (action === 'list') return await listRunbooks(exec)
      if (action === 'validate') return await validate(args, exec)
      return await plan(args, exec)
    },
    presentCall(args) {
      const action = args.action !== undefined ? String(args.action) : '(missing)'
      const name = typeof args.runbook === 'string' ? args.runbook
        : (args.runbook !== null && typeof args.runbook === 'object' && args.runbook.name !== undefined ? String(args.runbook.name) : undefined)
      return {
        card: 'generic',
        title: 'Runbook ' + action + (name !== undefined ? ' · ' + name : ''),
        kind: 'read',
        rawInput: omitUndefined({ action, runbook: name }),
        content: [{ type: 'text', text: action === 'list' ? '扫描工作区 ' + RUNBOOK_DIR : (name !== undefined ? name : '内联') }],
      }
    },
  }
}
