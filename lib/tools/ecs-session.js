// ============================================================================
// lib/tools/ecs-session.js —— ecs_session: Workbench 会话管理(列表/关闭)
// 对应 CLI: workbench session list | workbench session close <id> | --all
// 一般无需手动管理(会话自动管理), 本工具用于排障与资源回收。
// ============================================================================
import { runWorkbench, decodeLoose, commandLine } from '../common.js'

export function ecsSessionDefinition(ctx) {
  return {
    name: 'ecs_session',
    description: '管理本机 Workbench CLI 的实例会话: 查看活动会话列表(排障时确认是否存在残留会话), ' +
      '或关闭指定/全部会话(资源回收)。一般无需手动管理, 用于诊断与清理。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'close'], description: 'list=查看活动会话; close=关闭会话' },
      session_id: { type: 'string', description: '要关闭的会话 ID(action=close 时使用)' },
      all: { type: 'boolean', description: '关闭全部会话(action=close 时使用)' },
    },
    timeoutMs: 60000,
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          exit_code: { type: 'integer' },
          message: { type: 'string' },
          sessions: { type: 'json' },
          command_line: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: (value.action === 'list' ? '会话列表\n' : '会话关闭\n') +
          (value.message.length > 0 ? value.message.replace(/\n$/, '') + '\n' : '') +
          '[exit code: ' + value.exit_code + ']',
      }],
    },
    async execute(args, exec) {
      let argv
      if (args.action === 'list') {
        argv = ['session', 'list', '--output', 'json']
      } else if (args.action === 'close') {
        if (args.all === true) {
          argv = ['session', 'close', '--all', '--output', 'json']
        } else if (args.session_id !== undefined && args.session_id.length > 0) {
          argv = ['session', 'close', args.session_id, '--output', 'json']
        } else {
          throw new Error('ecs_session: action=close 时需要 session_id 或 all=true')
        }
      } else {
        throw new Error('ecs_session: action 仅支持 list | close')
      }

      const r = await runWorkbench(ctx, argv, exec.signal)
      if (exec.signal.aborted) throw new Error('工具调用已被取消')

      const decoded = decodeLoose(r, 'ecs_session')
      return {
        action: args.action,
        exit_code: r.exitCode !== null ? r.exitCode : 0,
        message: decoded.text.length > 0 ? decoded.text : (decoded.json !== undefined ? JSON.stringify(decoded.json) : ''),
        sessions: decoded.json,
        command_line: commandLine(argv),
      }
    },
  }
}
