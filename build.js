#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

console.log('🔧 Post-processing JavaScript files...');

function walkDir(dir) {
  const files = [];
  const items = readdirSync(dir);
  
  for (const item of items) {
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (item.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

try {
  // Find all .js files in dist
  const jsFiles = walkDir('dist');
  
  console.log(`🔧 Fixing import paths in ${jsFiles.length} files...`);
  
  for (const file of jsFiles) {
    let content = readFileSync(file, 'utf8');
    
    // Fix relative imports that are missing .js extensions
    content = content.replace(
      /from\s+['"](\.[^'"]*?)(?<!\.js)['"]/g,
      "from '$1.js'"
    );
    
    // Fix import statements too
    content = content.replace(
      /import\s+([^'"]*?)\s+from\s+['"](\.[^'"]*?)(?<!\.js)['"]/g,
      "import $1 from '$2.js'"
    );
    
    writeFileSync(file, content, 'utf8');
  }
  
  console.log('✅ Import paths fixed');
  console.log('🎉 Post-processing completed successfully!');
  
} catch (error) {
  console.error('❌ Post-processing failed:', error.message);
  process.exit(1);
}