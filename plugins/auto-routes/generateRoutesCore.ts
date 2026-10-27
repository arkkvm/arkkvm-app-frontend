/**
 * @Purpose: Auto-generate route configuration from page files
 * @Descripttion:
 * @version:
 * @Author: zhanglei
 * @Date: 2025-07-21 18:15:01
 * @LastEditors: zhanglei
 * @LastEditTime: 2026-03-26 17:47:47
 */
import fs from 'fs';
import path from 'path';

// Route info shape used by route generation
interface RouteInfo {
  routePath: string;
  importPath: string;
  filePath?: string;
  meta?: any;
}
const pagesDir = getPagesDir();
const outPath = path.resolve(__dirname, '../../src/router/routeConfig.ts');
// Resolve pages directory path
function getPagesDir() {
  const baseDir = path.resolve(__dirname, '../../src');
  // Support both `pages` and legacy `page` directories
  if (fs.existsSync(path.join(baseDir, 'pages'))) {
    return path.join(baseDir, 'pages');
  } else if (fs.existsSync(path.join(baseDir, 'page'))) {
    return path.join(baseDir, 'page');
  }
  console.warn('⚠️ Neither pages nor page directory found, defaulting to page');
  return path.join(baseDir, 'page');
}
function walk(dir: string, baseRoute = ''): RouteInfo[] {
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️ Directory does not exist: ${dir}`);
    return [];
  }

  const entries = fs.readdirSync(dir);
  const routes: RouteInfo[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const subRoutes = walk(fullPath, path.join(baseRoute, entry));
      routes.push(...subRoutes as RouteInfo[]);
      continue;
    }

    // Support `.page.tsx` files and `index.tsx`
    if (entry.endsWith('.page.tsx') || entry === 'index.tsx') {
      let routePath = path.join(baseRoute, entry.replace(/\.(page\.)?tsx$/, ''));
      routePath = routePath.replace(/\\/g, '/'); // Windows path compatibility
      routePath = routePath.replace(/\/index$/, '');
      routePath = routePath.replace(/\[([^\]]+)\]/g, ':$1');

      // Build import path in `@/pages/...` style compatible with src/page(s)
      let importPath = '@' + fullPath
        .replace(path.resolve(__dirname, '../../src'), '')
        .replace(/\\/g, '/')
        .replace(/\.tsx$/, '');

      routes.push({
        routePath: routePath || '/',
        importPath
      } as RouteInfo);
    }
  }

  return routes;
}
// Statically parse page file content to extract `meta`
function extractMetaFromFile(filePath: string): any {
  const content = fs.readFileSync(filePath, 'utf-8');

  const match = content.match(/export\s+const\s+meta\s*(?::\s*\w+\s*)?=\s*({[\s\S]*?})\s*;?\s*(?=\n|$|import|export|const|let|var|function|class)/);
  if (match) {
    try {
      return new Function('return ' + match[1])();
    } catch (e) {
      console.warn('⚠️ Failed to parse meta export', filePath, e);
      return {};
    }
  }
  console.warn('⚠️ No meta export found', filePath);
  return {};
}

async function generate() {
  // Ensure output directory exists
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const routeInfos = walk(pagesDir).map((info: RouteInfo) => {
    // Convert import path (e.g. '@/pages/xxx') to a source-relative path
    const relativeImportPath = info.importPath.replace(/^@\/?/, '');
    // Build absolute file path safely via path.join
    const filePath = path.join(path.resolve(__dirname, '../../src'), relativeImportPath + '.tsx');
    return {
      ...info,
      filePath,
    };
  });
  // Both build targets share this generated file. Keep its contents independent
  // of the generating process so a cloud build cannot replace device dev routes.
  const routeEntries: Record<'device' | 'cloud', string[]> = { device: [], cloud: [] };

  for (const { routePath, importPath, filePath } of routeInfos as RouteInfo[]) {
    if (!filePath || !fs.existsSync(filePath)) {
      console.error('❌ Page file does not exist, skipped:', filePath || importPath);
      continue;
    }
    try {
      // Statically parse page meta
      const meta = extractMetaFromFile(filePath);
      // Allow meta.path / meta.cloudPath to override generated route path
      for (const buildTarget of ['device', 'cloud'] as const) {
        let finalPath = routePath;

        // Filter routes by page target so only relevant routes are bundled
        const pageTarget = meta.target || 'universal'; // default: universal

        // Keep only pages required by the current build target
        if (buildTarget === 'cloud' && pageTarget === 'device') {
          console.log(`⏭️ Skipping device-only page: ${filePath}`);
          continue;
        }
        if (buildTarget === 'device' && pageTarget === 'cloud') {
          console.log(`⏭️ Skipping cloud-only page: ${filePath}`);
          continue;
        }

        // Choose the route path based on build target
        let candidatePath = '';
        if (buildTarget === 'cloud' && typeof meta.cloudPath === 'string' && meta.cloudPath.trim() !== '') {
          candidatePath = meta.cloudPath;
        } else if (typeof meta.path === 'string' && meta.path.trim() !== '') {
          candidatePath = meta.path;
        }

        if (candidatePath) {
          finalPath = candidatePath.startsWith('/') ? candidatePath : `/${candidatePath}`;
          // Preserve root path '/' from trailing-slash cleanup
          if (finalPath !== '/') {
            finalPath = finalPath.replace(/\/+$/, '');
          }
        }

        const metaCopy = { ...meta };
        delete metaCopy.path;
        delete metaCopy.cloudPath;
        delete metaCopy.target;
        // Note: finalPath should already be sanitized, no need for aggressive cleaning
        // Only ensure it starts with '/' if not empty
        if (finalPath && !finalPath.startsWith('/')) {
          finalPath = '/' + finalPath;
        }
        const indent = '  ';
        const metaStr = Object.entries(metaCopy).length > 0
          ? `,\n${indent.repeat(3)}meta: ${JSON.stringify(metaCopy, null, 2).replace(/\n/g, `\n${indent.repeat(3)}`)}`
          : '';
        const routeStr = `${indent.repeat(1)}{\n${indent.repeat(2)}path: '${finalPath}',\n${indent.repeat(2)}element: lazy(() => import('${importPath}'))${metaStr}\n${indent.repeat(1)}}`;
        routeEntries[buildTarget].push(routeStr);
      }
    } catch (error) {
    }
  }

  const fileContent = `/* This file is auto-generated by generateRoutes.ts. Do not edit manually. */\nimport { lazy } from 'react';\nimport { RouteObject } from 'react-router-dom';\n\nexport interface CustomRouteObject extends RouteObject {\n  meta?: {\n    auth?: boolean;\n    title?: string;\n    isMenu?: boolean;\n    icon?: string;\n    target?: 'device' | 'cloud' | 'universal';\n  };\n}\n\nexport const routes: CustomRouteObject[] = process.env.BUILD_TARGET === 'cloud' ? [\n${routeEntries.cloud.join(',\n')}\n] : [\n${routeEntries.device.join(',\n')}\n];\n`;

  try {
    if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf-8') === fileContent) {
      return;
    }
    fs.writeFileSync(outPath, fileContent, 'utf-8');
    console.log('✅ routeConfig.ts generated successfully');
  } catch (err) {
    console.error('❌ Failed to write routeConfig.ts:', err);
  }
}

export default generate;
