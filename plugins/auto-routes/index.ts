import type { RsbuildPlugin } from '@rsbuild/core';
import path from 'path';

// Import the core route generation logic
import generate from './generateRoutesCore';

// Delay helper used by retry logic
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry wrapper for route generation
async function generateWithRetry(maxRetries = 3, delayMs = 1000) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Attempting route generation (${attempt}/${maxRetries})...`);
      await generate();
      console.log('✅ Route generation succeeded');
      return true;
    } catch (error) {
      lastError = error;
      console.error(`❌ Route generation failed (${attempt}/${maxRetries}):`, error.message);

      if (attempt < maxRetries) {
        console.log(`⏳ Retrying in ${delayMs}ms...`);
        await delay(delayMs);
      }
    }
  }

  console.error('❌ Maximum retries reached, route generation failed');
  throw lastError;
}

export const autoRoutesPlugin = (): RsbuildPlugin => ({
  name: 'auto-routes-plugin',

  setup(api) {
    // Generate routes once before the dev server starts
    api.modifyBundlerChain(async () => {
      console.log('🚀 Initializing route configuration...');
      try {
        await generateWithRetry();
      } catch (error) {
        console.error('❌ Failed to initialize route configuration:', error);
        // Do not throw to avoid blocking dev server startup
      }
      return;
    });

    // Regenerate routes when relevant files change
    api.onDevCompileDone(async ({ changedFiles }) => {
      if (!changedFiles) return;

      const pageFiles = Array.from(changedFiles).filter(
        file => file.endsWith('.page.tsx') || file.endsWith('index.tsx')
      );

      if (pageFiles.length > 0) {
        console.log('📝 Detected page file changes:');
        pageFiles.forEach(file => {
          console.log(`- ${path.relative(process.cwd(), file)}`);
        });

        console.log('🔄 Regenerating route configuration...');
        try {
          await generateWithRetry(2, 500);
        } catch (error) {
          console.error('❌ Route regeneration failed:', error);
          return; // Stop subsequent logic on regeneration failure
        }

        // The generator writes only when routes change; Rsbuild watches that
        // change directly. Page-only edits already participate in normal HMR.
      }
    });
  }
});

export default autoRoutesPlugin;
