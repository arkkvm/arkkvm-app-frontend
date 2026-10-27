/**
 * Rsbuild Configuration
 *
 * Environment variables can be provided by run.sh/build.sh, package scripts,
 * CI, or .env defaults. Runtime values from process.env take priority over
 * .env values.
 */
import { defineConfig, loadEnv, rspack } from '@rsbuild/core'
import type { BundlerPluginInstance, ProxyConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { pluginSvgr } from '@rsbuild/plugin-svgr'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import webpackBundleAnalyzer from 'webpack-bundle-analyzer'
import autoComponentsPlugin from './plugins/auto-components'
import autoRoutesPlugin from './plugins/auto-routes'
import { svgIndexPlugin } from './plugins/svg-index-plugin'

const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, 'package.json'), 'utf-8')
) as { version?: string }

type BuildTarget = 'device' | 'cloud'
type CloudBuildMode = 'versioned' | 'flat'

type BundleAnalyzerPluginOptions = {
  analyzerMode: 'static'
  openAnalyzer: boolean
  reportFilename: string
}

const { BundleAnalyzerPlugin } = webpackBundleAnalyzer as unknown as {
  BundleAnalyzerPlugin: new (
    options: BundleAnalyzerPluginOptions
  ) => BundlerPluginInstance
}

function normalizeUrl(value?: string): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return ''

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`

  return withProtocol.replace(/\/+$/, '')
}

function resolveBuildTarget(value?: string): BuildTarget {
  return value?.trim().toLowerCase() === 'cloud' ? 'cloud' : 'device'
}

function resolveCloudBuildMode(value?: string): CloudBuildMode {
  return value?.trim().toLowerCase() === 'flat' ? 'flat' : 'versioned'
}

function resolveAppVersion(envVersion?: string): string {
  return envVersion?.trim() || packageJson.version?.trim() || '0.0.0'
}

function resolveOutputOptions(params: {
  buildTarget: BuildTarget
  cloudBuildMode: CloudBuildMode
  appVersion: string
  isProdBuild: boolean
}): { assetPrefix: string; distRoot: string } {
  if (params.buildTarget !== 'cloud') {
    return {
      assetPrefix: '/',
      distRoot: 'dist/device',
    }
  }

  if (params.cloudBuildMode === 'flat') {
    return {
      assetPrefix: '/',
      distRoot: 'dist/cloud',
    }
  }

  return {
    assetPrefix: params.isProdBuild ? `/${params.appVersion}/` : '/',
    distRoot: `dist/${params.appVersion}`,
  }
}

function createDefineEnv(params: {
  publicVars: Record<string, string>
  buildTarget: BuildTarget
  cloudBuildMode: CloudBuildMode
  appVersion: string
  buildTime: string
  buildTimestamp: number
}): Record<string, string> {
  return {
    ...params.publicVars,
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'development'
    ),
    'process.env.BUILD_TARGET': JSON.stringify(params.buildTarget),
    'process.env.CLOUD_BUILD_MODE': JSON.stringify(params.cloudBuildMode),
    'process.env.APP_VERSION': JSON.stringify(params.appVersion),
    'process.env.BUILD_TIME': JSON.stringify(params.buildTime),
    'process.env.BUILD_TIMESTAMP': JSON.stringify(params.buildTimestamp),
  }
}

function createProxyConfig(deviceApiUrl: string): ProxyConfig | undefined {
  if (!deviceApiUrl) return undefined

  const deviceHeaders = {
    Origin: deviceApiUrl,
    Referer: `${deviceApiUrl}/`,
  }

  return {
    '/api': {
      target: deviceApiUrl,
      changeOrigin: true,
      secure: false,
      pathRewrite: { '^/api': '' },
      headers: deviceHeaders,
    },
    '/cloud': {
      target: deviceApiUrl,
      changeOrigin: true,
      secure: false,
    },
    '/webrtc': {
      target: deviceApiUrl,
      changeOrigin: true,
      secure: false,
      ws: true,
      headers: deviceHeaders,
    },
  }
}

function createRspackPlugins(enableAnalyze: boolean): BundlerPluginInstance[] {
  const plugins: BundlerPluginInstance[] = [
    new rspack.ProvidePlugin({
      process: 'process/browser',
    }),
  ]

  if (enableAnalyze) {
    plugins.push(
      new BundleAnalyzerPlugin({
        analyzerMode: 'static',
        openAnalyzer: true,
        reportFilename: 'bundle-report.html',
      })
    )
  }

  return plugins
}

export default defineConfig(({ mode }) => {
  const BUILD_TIME = new Date().toISOString()
  const BUILD_TIMESTAMP = Date.now()
  const BUILD_TIME_READABLE = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15)

  const { parsed, publicVars } = loadEnv({
    cwd: __dirname,
    prefixes: ['RSB_'],
  })

  const PORT = Number(process.env.RSB_PORT || parsed.RSB_PORT) || 9000
  const rawApiUrl =
    process.env.RSB_API_BASE_URL || parsed.RSB_API_BASE_URL || ''
  const DEVICE_API_URL = normalizeUrl(rawApiUrl)
  const BUILD_TARGET = resolveBuildTarget(
    process.env.BUILD_TARGET || parsed.RSB_TARGET_MODE
  )
  const CLOUD_BUILD_MODE = resolveCloudBuildMode(process.env.CLOUD_BUILD_MODE)
  const APP_VERSION = resolveAppVersion(
    process.env.RSB_APP_VERSION || parsed.RSB_APP_VERSION
  )
  const isProdBuild = (process.env.NODE_ENV || mode) === 'production'
  const enableAnalyze = process.env.ANALYZE === '1'

  if (process.env.DEBUG_BUILD === '1') {
    console.log('[rsbuild] build target:', BUILD_TARGET)
    console.log('[rsbuild] cloud build mode:', CLOUD_BUILD_MODE)
    console.log('[rsbuild] device api url:', DEVICE_API_URL || '<empty>')
    console.log('[rsbuild] app version:', APP_VERSION)
  }

  const defineEnv = createDefineEnv({
    publicVars,
    buildTarget: BUILD_TARGET,
    cloudBuildMode: CLOUD_BUILD_MODE,
    appVersion: APP_VERSION,
    buildTime: BUILD_TIME,
    buildTimestamp: BUILD_TIMESTAMP,
  })

  // Runtime-only cloud packages deliberately omit all injected cloud addresses.
  if (BUILD_TARGET === 'cloud' && process.env.ARKKVM_CLOUD_RUNTIME_ONLY === '1') {
    for (const key of [
      'RSB_API_BASE_URL', 'RSB_API_DOMAIN',
      'RSB_API_BASE_URL_CLOUD', 'RSB_APP_BASE_URL_CLOUD',
      'RSB_API_BASE_URL_CLOUD_CN', 'RSB_APP_BASE_URL_CLOUD_CN',
    ]) {
      defineEnv[`import.meta.env.${key}`] = JSON.stringify('');
      defineEnv[`process.env.${key}`] = JSON.stringify('');
    }
  }

  const { assetPrefix, distRoot } = resolveOutputOptions({
    buildTarget: BUILD_TARGET,
    cloudBuildMode: CLOUD_BUILD_MODE,
    appVersion: APP_VERSION,
    isProdBuild,
  })

  return {
    output: {
      distPath: {
        root: process.env.ARKKVM_OUTPUT_DIR || distRoot,
      },
      assetPrefix,
    },
    source: {
      define: defineEnv,
    },
    html: {
      favicon: path.resolve(__dirname, 'src/assets/icons/logo.svg'),
      title: 'ArkKVM',
      meta: {
        google: 'notranslate',
      },
    },
    plugins: [
      pluginReact(),
      pluginSvgr({
        svgrOptions: {
          exportType: 'named',
        },
        mixedImport: true,
      }),
      autoRoutesPlugin(),
      autoComponentsPlugin(),
      svgIndexPlugin({
        inputDir: path.resolve(__dirname, 'src/assets/icons'),
      }),
    ],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    server: {
      port: PORT,
      open: true,
      host: '0.0.0.0',
      proxy: createProxyConfig(DEVICE_API_URL),
    },
    tools: {
      rspack: {
        resolve: {
          fallback: {
            process: fileURLToPath(import.meta.resolve('process/browser')),
          },
        },
        plugins: createRspackPlugins(enableAnalyze),
        performance: {
          removeConsole: isProdBuild ? ['log', 'info', 'debug'] : false,
          removeDebugger: isProdBuild,
        },
        output: {
          sourceMap: !isProdBuild,
          filename: isProdBuild
            ? `js/[name].[contenthash:8].v${APP_VERSION}.${BUILD_TIME_READABLE}.js`
            : `js/[name].js`,
          chunkFilename: isProdBuild
            ? `js/[name].[contenthash:8].v${APP_VERSION}.${BUILD_TIME_READABLE}.js`
            : `js/[name].js`,
          assetModuleFilename: isProdBuild
            ? `assets/[name].[contenthash:8].v${APP_VERSION}.${BUILD_TIME_READABLE}[ext]`
            : `assets/[name][ext]`,
        },
      },
    },
    module: {
      rules: [
        {
          test: /\.css$/,
          use: ['postcss-loader'],
          type: 'css',
        },
      ],
    },
  }
})
