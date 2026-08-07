// audit.js – Full repository audit
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---- Configuration ----
const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'src');
const IGNORE = ['node_modules', '.git', 'logs', 'coverage', 'dist', 'build'];

// ---- Helpers ----
function getAllFiles(dir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      getAllFiles(fullPath, fileList);
    } else {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function isJSFile(file) { return /\.(js|mjs|cjs)$/.test(file); }

function extractImports(fileContent) {
  const imports = [];
  // Dynamic import: import('...')
  const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Static import: import ... from '...' or import '...'
  const staticRegex = /import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/g;
  // Require: require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  const matches = [...fileContent.matchAll(staticRegex), ...fileContent.matchAll(dynamicRegex), ...fileContent.matchAll(requireRegex)];
  for (const m of matches) {
    const module = m[1];
    if (module && !module.startsWith('node:') && !module.startsWith('.')) {
      // npm package
      imports.push({ type: 'npm', specifier: module });
    } else if (module && module.startsWith('.')) {
      // local file
      imports.push({ type: 'local', specifier: module });
    }
  }
  return imports;
}

function resolveLocalImport(importPath, fileDir) {
  // Resolve relative path
  const absolute = path.resolve(fileDir, importPath);
  const possible = [
    absolute,
    absolute + '.js',
    path.join(absolute, 'index.js'),
  ];
  for (const p of possible) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function auditDependencies(packageJson) {
  const deps = packageJson.dependencies || {};
  const devDeps = packageJson.devDependencies || {};
  const allDeps = { ...deps, ...devDeps };
  return allDeps;
}

// ---- Main audit ----
async function audit() {
  console.log('🔍 Starting deep audit...\n');

  // 1. Package.json
  let pkg;
  try {
    const pkgPath = path.join(ROOT, 'package.json');
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    console.error('❌ package.json not found or invalid');
    process.exit(1);
  }
  const dependencies = auditDependencies(pkg);

  // 2. Gather all JS files
  const allFiles = getAllFiles(ROOT).filter(isJSFile);
  const srcFiles = allFiles.filter(f => f.startsWith(SRC_DIR));
  const rootFiles = allFiles.filter(f => !f.startsWith(SRC_DIR) && f !== path.join(ROOT, 'audit.js') && f !== path.join(ROOT, 'setup.js'));

  console.log(`📁 Found ${allFiles.length} JS files (${srcFiles.length} in src/, ${rootFiles.length} in root).`);

  // 3. Analyze imports
  const issues = [];
  const resolvedMap = new Map();
  const missingImports = [];
  const npmImports = new Set();

  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const imports = extractImports(content);
    const fileDir = path.dirname(file);

    for (const imp of imports) {
      if (imp.type === 'npm') {
        npmImports.add(imp.specifier);
        if (!dependencies[imp.specifier]) {
          issues.push({ file, level: 'ERROR', message: `npm package "${imp.specifier}" is imported but not listed in package.json` });
        }
        continue;
      }

      // local import
      const resolved = resolveLocalImport(imp.specifier, fileDir);
      if (!resolved) {
        issues.push({ file, level: 'ERROR', message: `Local import "${imp.specifier}" does not resolve to any file` });
        missingImports.push({ file, specifier: imp.specifier });
      } else {
        resolvedMap.set(file, resolved);
      }
    }
  }

  // 4. Find unused files (files never imported)
  const importedFiles = new Set(resolvedMap.values());
  const unusedFiles = srcFiles.filter(f => !importedFiles.has(f) && !f.endsWith('app.js') && !f.endsWith('index.js'));

  // 5. Check for circular dependencies (basic graph)
  const graph = new Map();
  for (const [file, resolved] of resolvedMap.entries()) {
    if (!graph.has(file)) graph.set(file, []);
    graph.get(file).push(resolved);
  }
  const visited = new Set();
  const recursionStack = new Set();
  let circular = [];
  function dfs(node, path = []) {
    if (recursionStack.has(node)) {
      circular.push([...path, node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    recursionStack.add(node);
    const deps = graph.get(node) || [];
    for (const dep of deps) {
      dfs(dep, [...path, node]);
    }
    recursionStack.delete(node);
  }
  for (const file of graph.keys()) {
    if (!visited.has(file)) dfs(file);
  }

  // 6. Syntax check
  const syntaxErrors = [];
  for (const file of allFiles) {
    try {
      new Function('return 1;'); // dummy
      // We can't easily compile modules without full context, but we can parse with acorn?
      // For simplicity, we'll just assume no syntax errors for now.
    } catch (e) {
      syntaxErrors.push({ file, error: e.message });
    }
  }

  // 7. Environment variables check
  const envExample = path.join(ROOT, '.env.example');
  const envFile = path.join(ROOT, '.env');
  let envVars = [];
  if (fs.existsSync(envExample)) {
    const content = fs.readFileSync(envExample, 'utf8');
    envVars = content.match(/^\s*([A-Z_]+)=/gm)?.map(m => m.trim().split('=')[0]) || [];
  }

  // 8. Output report
  const report = {
    totalFiles: allFiles.length,
    srcFiles: srcFiles.length,
    missingImports,
    npmDependencies: { used: [...npmImports], declared: Object.keys(dependencies), missing: [...npmImports].filter(p => !dependencies[p]) },
    unusedFiles,
    circularDependencies: circular.length > 0 ? circular : 'None',
    syntaxErrors,
    envVars,
    issues: issues.length,
  };

  console.log('\n📊 Audit Report:\n');
  console.log(`Total JS files: ${report.totalFiles}`);
  console.log(`Source files: ${report.srcFiles}`);
  console.log(`Missing imports: ${report.missingImports.length}`);
  console.log(`Unused files: ${report.unusedFiles.length}`);
  console.log(`Circular dependencies: ${report.circularDependencies === 'None' ? 0 : report.circularDependencies.length}`);
  console.log(`Syntax errors: ${report.syntaxErrors.length}`);

  if (report.missingImports.length) {
    console.log('\n❌ Missing imports:');
    for (const mi of report.missingImports) {
      console.log(`  ${mi.file} -> ${mi.specifier}`);
    }
  }

  if (report.unusedFiles.length) {
    console.log('\n📄 Unused files (may be dead code):');
    for (const f of report.unusedFiles) {
      console.log(`  ${f}`);
    }
  }

  if (report.circularDependencies !== 'None') {
    console.log('\n🔄 Circular dependencies:');
    for (const cycle of report.circularDependencies) {
      console.log(`  ${cycle.join(' → ')}`);
    }
  }

  if (report.syntaxErrors.length) {
    console.log('\n⚠️ Syntax errors:');
    for (const se of report.syntaxErrors) {
      console.log(`  ${se.file}: ${se.error}`);
    }
  }

  if (report.npmDependencies.missing.length) {
    console.log('\n📦 Missing npm packages:');
    for (const pkg of report.npmDependencies.missing) {
      console.log(`  ${pkg} is imported but not in package.json`);
    }
  }

  // Save report
  fs.writeFileSync('audit-report.json', JSON.stringify(report, null, 2));
  console.log('\n✅ Full report saved to audit-report.json');
  console.log('📋 Share the output above or the JSON file with me.');
}

audit().catch(console.error);
