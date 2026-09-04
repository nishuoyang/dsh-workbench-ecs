// ============================================================================
// lib/types/index.d.ts —— 插件类型声明
// 提供: 插件元信息与 apply 签名, 以及各工具的参考参数接口(供 TS 宿主/代码模式参考)
// ============================================================================

/** 插件名 */
export const name: 'dsh-workbench-ecs'

/** 插件注入的服务 */
export const inject: readonly ['tools']

/** Cordis apply: 注册全部 Workbench ECS 工具 */
export function apply(ctx: unknown): void

/** ecs_list 参数 */
export interface EcsListArgs {
  region: string
  status?: 'Running' | 'Stopped' | 'Starting' | 'Stopping'
  tag?: string[]
  instance_type?: string
  instance_name?: string
  limit?: number
}

/** ecs_exec 参数 */
export interface EcsExecArgs {
  instance_id?: string
  instance_ids?: string[]
  command: string
  timeout?: number
  region?: string
  run_in_background?: boolean
}

/** ecs_upload 参数 */
export interface EcsUploadArgs {
  local_file: string
  remote_path: string
  instance_id: string
  region?: string
  force?: boolean
}

/** ecs_download 参数 */
export interface EcsDownloadArgs {
  remote_path: string
  local_path?: string
  instance_id: string
  region?: string
  force?: boolean
}

/** ecs_diagnose 参数 */
export interface EcsDiagnoseArgs {
  instance_id: string
  region?: string
  extra_command?: string
  timeout?: number
}

/** ecs_deploy 参数 */
export interface EcsDeployArgs {
  instance_id: string
  command: string
  local_file?: string
  remote_path?: string
  health_check?: string
  region?: string
  force?: boolean
  timeout?: number
}

/** ecs_session 参数 */
export interface EcsSessionArgs {
  action: 'list' | 'close'
  session_id?: string
  all?: boolean
}
