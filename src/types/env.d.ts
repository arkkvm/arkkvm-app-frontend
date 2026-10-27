/**
 * @Purpose: Env var type definitions
 * @Author: zhanglei
 * @Date: 2025-07-15 15:05:00
 */
interface ImportMetaEnv {
  readonly RSB_MODE?: 'development' | 'production' | string

  /** Target runtime: device | cloud */
  readonly RSB_TARGET_MODE?: 'device' | 'cloud'
  readonly RSB_API_BASE_URL?: string
  readonly RSB_SIGNALING_URL?: string

   readonly RSB_IP_ADDRESS?: string
    readonly RSB_API_DOMAIN?: string

  readonly RSB_API_BASE_URL_CLOUD?: string
  readonly RSB_APP_BASE_URL_CLOUD?: string
  readonly RSB_API_BASE_URL_CLOUD_CN?: string
  readonly RSB_APP_BASE_URL_CLOUD_CN?: string
  readonly MODE: string
  readonly PROD: boolean
  readonly DEV: boolean
  readonly BASE_URL: string
  readonly [key: `RSB_${string}`]: string | boolean | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
