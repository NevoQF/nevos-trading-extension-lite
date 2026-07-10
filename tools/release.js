const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync: spawn_sync } = require("child_process");
const { createRequire: create_require } = require("module");

const tool_dir = __dirname;
const repo_dir = path.resolve(tool_dir, "..");
const ext_subdir = path.join(repo_dir, "extension");
const ext_dir = fs.existsSync(path.join(ext_subdir, "manifest.json")) ? ext_subdir : repo_dir;
const default_dist = path.join(repo_dir, "dist");
const minify_concurrency = Math.max(2, os.cpus().length || 4);
const ignored_names = new Set([
  ".git",
  ".gitignore",
  "dist",
  "tools",
  "manifest.firefox.json",
  "manifest.safari.json",
]);
const ignored_paths = new Set();
const ignored_prefixes = [];
const valid_targets = new Set(["chrome", "brave", "edge", "firefox", "opera", "safari"]);
const valid_variants = new Set(["full", "lite"]);
const lite_drop_host_permissions = new Set([
  "https://routility.io/*",
  "https://roautotrade.com/*",
  "https://nevos-extension.com/*",
  "https://www.nevos-extension.com/*",
  "https://discord.com/api/webhooks/*",
  "https://www.discord.com/api/webhooks/*",
  "https://canary.discord.com/api/webhooks/*",
  "https://ptb.discord.com/api/webhooks/*",
  "https://discordapp.com/api/webhooks/*",
  "https://www.discordapp.com/api/webhooks/*",
]);
const lite_drop_files = [
  "content/analyze_trade.js",
  "background/trade_ad_notifications.js",
  "background/inbound_trade_webhook_preview.js",
  "shared/trade_ad_notifications_core.js",
  "popup/trade_ad_notifications_ui.js",
  "shared/nte_history_proof_styles.js",
  "assets/routility.png",
];
const target_groups = [
  { id: "chromium", minify_as: "chrome", targets: ["chrome", "edge", "opera"] },
  { id: "brave", minify_as: "brave", targets: ["brave"] },
  { id: "firefox", minify_as: "firefox", targets: ["firefox"] },
  { id: "safari", minify_as: "safari", targets: ["safari"] },
];

function parse_args(argv) {
  const options = {
    outDir: default_dist,
    zipName: null,
    keepStaging: false,
    unpack: false,
    variant: "full",
    targets: ["chrome", "brave", "edge", "opera", "firefox", "safari"],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out-dir") {
      options.outDir = path.resolve(argv[++i]);
    } else if (arg === "--zip-name") {
      options.zipName = argv[++i];
    } else if (arg === "--keep-staging") {
      options.keepStaging = true;
    } else if (arg === "--unpack") {
      options.unpack = true;
    } else if (arg === "--variant") {
      const value = String(argv[++i] || "").toLowerCase();
      if (!valid_variants.has(value)) {
        throw new Error(`Invalid variant: ${value}`);
      }
      options.variant = value;
    } else if (arg === "--target") {
      const value = String(argv[++i] || "").toLowerCase();
      if (!valid_targets.has(value)) {
        throw new Error(`Invalid target: ${value}`);
      }
      options.targets = [value];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function find_workspace_root(start_dir) {
  let current = start_dir;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return start_dir;
    }
    current = parent;
  }
}

function load_terser() {
  const workspace_root = find_workspace_root(repo_dir);
  const candidates = [
    process.env.NTE_TERSER_PATH,
    path.join(repo_dir, "node_modules", "terser"),
    path.join(ext_dir, "node_modules", "terser"),
    path.join(workspace_root, "node_modules", "terser"),
    path.join(workspace_root, "nevoebooks.store", "node_modules", "terser"),
    path.join(workspace_root, "subby_website", "node_modules", "terser"),
    path.join(workspace_root, "VIPFiddler", "pack", "node_modules", "terser"),
    path.join(workspace_root, "Catflipper", "catflipper loader premium", "node_modules", "terser"),
    path.join(workspace_root, "Catflipper", "catflipper loader free", "node_modules", "terser"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const req = create_require(path.join(candidate, "package.json"));
      return req(candidate);
    } catch (_error) {

    }
  }

  throw new Error(
    [
      "Could not locate a local terser installation.",
      "Set NTE_TERSER_PATH to a terser package directory or install terser in this workspace.",
    ].join(" ")
  );
}

function ensure_dir(dir_path) {
  fs.mkdirSync(dir_path, { recursive: true });
}

function walk(dir_path, results = []) {
  const entries = fs.readdirSync(dir_path, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored_names.has(entry.name)) {
      continue;
    }

    const full_path = path.join(dir_path, entry.name);
    if (entry.isDirectory()) {
      walk(full_path, results);
    } else {
      const rel_path = path.relative(ext_dir, full_path);
      if (ignored_paths.has(rel_path)) {
        continue;
      }
      if (ignored_prefixes.some((prefix) => rel_path.startsWith(prefix))) {
        continue;
      }
      results.push(full_path);
    }
  }
  return results;
}

function minify_css(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function minify_html(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function map_pool(items, limit, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next_index = 0;

  async function worker() {
    while (true) {
      const index = next_index;
      next_index += 1;
      if (index >= items.length) break;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function copy_or_minify_file(src_path, dst_path) {
  const ext = path.extname(src_path).toLowerCase();
  if (ext === ".css") {
    const input = fs.readFileSync(src_path, "utf8");
    fs.writeFileSync(dst_path, minify_css(input), "utf8");
    return;
  }

  if (ext === ".html") {
    const input = fs.readFileSync(src_path, "utf8");
    fs.writeFileSync(dst_path, minify_html(input), "utf8");
    return;
  }

  if (ext === ".json") {
    const input = fs.readFileSync(src_path, "utf8");
    fs.writeFileSync(dst_path, JSON.stringify(JSON.parse(input)), "utf8");
    return;
  }

  fs.copyFileSync(src_path, dst_path);
}

async function minify_js_file(src_path, dst_path, terser, target) {
  const input = fs.readFileSync(src_path, "utf8");
  const compress_options =
    target === "brave" ? { pure_funcs: ["console.info", "console.debug"] } : true;
  const result = await terser.minify(input, {
    compress: compress_options,
    mangle: true,
    ecma: 2020,
    format: { comments: false },
  });

  if (!result.code) {
    throw new Error(`Terser returned no output for ${path.relative(ext_dir, src_path)}`);
  }

  fs.writeFileSync(dst_path, result.code, "utf8");
}

async function write_minified_files(staging_dir, terser, target) {
  const files = walk(ext_dir);
  const js_files = [];
  const other_files = [];

  for (const src_path of files) {
    const ext = path.extname(src_path).toLowerCase();
    const rel_path = path.relative(ext_dir, src_path);
    const dst_path = path.join(staging_dir, rel_path);
    ensure_dir(path.dirname(dst_path));
    if (ext === ".js") {
      js_files.push({ src_path, dst_path });
    } else {
      other_files.push({ src_path, dst_path });
    }
  }

  for (const row of other_files) {
    copy_or_minify_file(row.src_path, row.dst_path);
  }

  await map_pool(js_files, minify_concurrency, async (row) => {
    await minify_js_file(row.src_path, row.dst_path, terser, target);
  });

  if (target === "firefox" || target === "safari") {
    const firefox_manifest_path = path.join(
      ext_dir,
      target === "firefox" ? "manifest.firefox.json" : "manifest.safari.json",
    );
    const manifest_dst_path = path.join(staging_dir, "manifest.json");
    const firefox_manifest = JSON.parse(fs.readFileSync(firefox_manifest_path, "utf8"));
    fs.writeFileSync(manifest_dst_path, JSON.stringify(firefox_manifest), "utf8");
  }
}

function zip_path_for(target, version, out_dir, zip_name_override, variant) {
  const variant_part = variant === "lite" ? "-lite" : "";
  const zip_name =
    zip_name_override ||
    `nevos-trading-extension${variant_part}-${target}-v${version}.zip`;
  return path.join(out_dir, zip_name);
}

function patch_manifest_for_lite(manifest) {
  manifest.name = "Nevos Trading Extension LITE";
  manifest.short_name = "Nevos LITE";
  manifest.description =
    "Client-side Roblox trading tools. Values from Rolimons. No backend required.";
  if (Array.isArray(manifest.host_permissions)) {
    manifest.host_permissions = manifest.host_permissions.filter(
      (host) => !lite_drop_host_permissions.has(host),
    );
  }
  if (Array.isArray(manifest.content_scripts)) {
    for (const entry of manifest.content_scripts) {
      if (!Array.isArray(entry.js)) continue;
      entry.js = entry.js.filter(
        (file) =>
          file !== "content/analyze_trade.js" &&
          file !== "shared/nte_history_proof_styles.js",
      );
    }
  }
  return manifest;
}

function apply_lite_variant(staging_dir) {
  const variant_path = path.join(staging_dir, "shared", "build_variant.js");
  const lite_variant_source = [
    "const NTE_IS_LITE=true;",
    'const NTE_LITE_DROP_OPTION_PATHS=["show-usd-values","analyze-trade","quick-proof"];',
    "function nte_is_lite(){return NTE_IS_LITE===true}",
    "function nte_filter_option_groups(groups){",
    "if(!nte_is_lite()||!Array.isArray(groups))return groups;",
    "let drop=new Set(NTE_LITE_DROP_OPTION_PATHS),out=[];",
    "for(let i=0;i<groups.length;i++){",
    "let item=groups[i];",
    'if(typeof item==="string"){',
    "let has=false;",
    "for(let j=i+1;j<groups.length;j++){",
    'if(typeof groups[j]==="string")break;',
    "if(groups[j]&&!drop.has(groups[j].path)){has=true;break}",
    "}",
    "if(has)out.push(item);continue",
    "}",
    "if(item&&!drop.has(item.path))out.push(item)",
    "}",
    "return out",
    "}",
    'function nte_product_name(){return nte_is_lite()?"Nevos Trading Extension LITE":"Nevos Trading Extension"}',
    'function nte_product_short_name(){return nte_is_lite()?"Nevos LITE":"Nevos Trade"}',
    "",
  ].join("");
  fs.writeFileSync(variant_path, lite_variant_source, "utf8");

  for (const rel of lite_drop_files) {
    const full = path.join(staging_dir, rel);
    if (fs.existsSync(full)) fs.rmSync(full, { force: true });
  }

  const popup_html = path.join(staging_dir, "popup", "popup.html");
  if (fs.existsSync(popup_html)) {
    let html = fs.readFileSync(popup_html, "utf8");
    html = html
      .replace(/<script src="\.\.\/shared\/trade_ad_notifications_core\.js"><\/script>\s*/g, "")
      .replace(/<script src="trade_ad_notifications_ui\.js"><\/script>\s*/g, "");
    fs.writeFileSync(popup_html, html, "utf8");
  }

  const manifest_path = path.join(staging_dir, "manifest.json");
  if (fs.existsSync(manifest_path)) {
    const manifest = JSON.parse(fs.readFileSync(manifest_path, "utf8"));
    patch_manifest_for_lite(manifest);
    fs.writeFileSync(manifest_path, JSON.stringify(manifest), "utf8");
  }
}

function zip_dir(staging_dir, zip_path) {
  if (fs.existsSync(zip_path)) {
    fs.rmSync(zip_path, { force: true });
  }

  const root = path.resolve(staging_dir);
  const escaped_root = root.replace(/'/g, "''");
  const escaped_zip = zip_path.replace(/'/g, "''");

  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zipPath = '${escaped_zip}'`,
    `$source = '${escaped_root}'`,
    "if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }",
    "$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)",
    "try {",
    "  $rootLen = $source.TrimEnd('\\','/').Length + 1",
    "  Get-ChildItem -LiteralPath $source -Recurse -File -Force | ForEach-Object {",
    "    $rel = $_.FullName.Substring($rootLen)",
    "    $entry = $rel -replace '\\\\', '/'",
    "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null",
    "  }",
    "} finally { $zip.Dispose() }",
  ].join("\n");

  const result = spawn_sync("powershell", ["-NoProfile", "-Command", ps], {
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(`Zip creation failed with exit code ${result.status}`);
  }
}

function spawn_async(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function unpack_zip(zip_path, dest_dir) {
  if (!fs.existsSync(zip_path)) {
    console.warn(`Skip unzip: not found ${zip_path}`);
    return;
  }

  if (fs.existsSync(dest_dir)) {
    fs.rmSync(dest_dir, { recursive: true, force: true });
  }

  const escaped_zip = zip_path.replace(/'/g, "''");
  const escaped_dest = dest_dir.replace(/'/g, "''");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `Expand-Archive -LiteralPath '${escaped_zip}' -DestinationPath '${escaped_dest}' -Force`,
  ].join("\n");

  await spawn_async("powershell", ["-NoProfile", "-Command", ps]);
  console.log(`Unpacked -> ${dest_dir}`);
}

function get_version() {
  const manifest_path = path.join(ext_dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifest_path, "utf8"));
  return manifest.version || "0.0.0";
}

function resolve_build_groups(targets) {
  const wanted = new Set(targets);
  const groups = [];

  for (const group of target_groups) {
    const active_targets = group.targets.filter((target) => wanted.has(target));
    if (!active_targets.length) continue;
    groups.push({
      ...group,
      targets: active_targets,
    });
  }

  return groups;
}

async function build_group(group, options, terser, version, out_dir) {
  const created_zips = [];
  const staging_dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `nte-release-${group.id}-`),
  );

  try {
    await write_minified_files(staging_dir, terser, group.minify_as);
    if (options.variant === "lite") {
      apply_lite_variant(staging_dir);
    }

    const [primary_target, ...alias_targets] = group.targets;
    const primary_zip = zip_path_for(
      primary_target,
      version,
      out_dir,
      options.targets.length === 1 ? options.zipName : null,
      options.variant,
    );
    zip_dir(staging_dir, primary_zip);
    console.log(`Created ${primary_target} release: ${primary_zip}`);
    created_zips.push({ target: primary_target, zip_path: primary_zip });

    for (const target of alias_targets) {
      const zip_path = zip_path_for(
        target,
        version,
        out_dir,
        null,
        options.variant,
      );
      fs.copyFileSync(primary_zip, zip_path);
      console.log(`Created ${target} release: ${zip_path}`);
      created_zips.push({ target, zip_path });
    }

    if (options.keepStaging) {
      console.log(`Staging directory kept at: ${staging_dir}`);
    }
  } finally {
    if (!options.keepStaging && fs.existsSync(staging_dir)) {
      fs.rmSync(staging_dir, { recursive: true, force: true });
    }
  }

  return created_zips;
}

async function main() {
  const started_at = Date.now();
  const options = parse_args(process.argv.slice(2));
  const terser = load_terser();
  const version = get_version();
  const out_dir = path.resolve(options.outDir);
  const groups = resolve_build_groups(options.targets);

  ensure_dir(out_dir);

  const built_groups = await Promise.all(
    groups.map((group) => build_group(group, options, terser, version, out_dir)),
  );
  const created_zips = built_groups.flat();

  if (options.unpack) {
    await Promise.all(
      created_zips.map(({ target, zip_path }) => {
        const variant_part = options.variant === "lite" ? "-lite" : "";
        const dest_dir = path.join(
          out_dir,
          `nevos-trading-extension${variant_part}-${target}-v${version}`,
        );
        return unpack_zip(zip_path, dest_dir);
      }),
    );
  }

  const elapsed_s = ((Date.now() - started_at) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed_s}s (${groups.length} build groups, ${created_zips.length} zips, variant=${options.variant})`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
