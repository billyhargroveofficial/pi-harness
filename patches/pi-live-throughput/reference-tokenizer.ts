// Explicit reference BPE, NOT a GPT-6/native tokenizer mapping. Content stays in RAM.
import { createRequire } from "node:module";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
export type ReferenceTokenizer = (text: string) => number;
export type TokenizerResolver = () => ReferenceTokenizer | undefined;
export function resolveReferenceTokenizer(options: { dir?: string; agentDir?: string } = {}): ReferenceTokenizer | undefined {
	const dir = options.dir ?? process.env.TPS_TOKENIZER_DIR
		?? join(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "tps-runtime");
	try {
		const root = resolve(dir);
		const directory = (path: string) => { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); };
		const file = (path: string) => { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink(); };
		if (!directory(root) || !file(join(root, "package.json"))) return undefined;
		const runtime = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (runtime.private !== true || runtime.dependencies?.["gpt-tokenizer"] !== "4.0.0"
			|| Object.keys(runtime.dependencies).length !== 1 || runtime.scripts || runtime.pi
			|| runtime.optionalDependencies) return undefined;
		const modules = join(root, "node_modules"), packageDir = join(modules, "gpt-tokenizer");
		if (!directory(modules) || !directory(packageDir)) return undefined;
		const packageRoot = realpathSync(packageDir);
		const inside = (path: string) => { const rel = relative(packageRoot, realpathSync(path)); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
		const require = createRequire(join(root, "package.json"));
		const manifest = require.resolve("gpt-tokenizer/package.json");
		const encoder = require.resolve("gpt-tokenizer/encoding/o200k_base");
		if (!file(manifest) || !file(encoder) || !inside(manifest) || !inside(encoder)) return undefined;
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		if (pkg.name !== "gpt-tokenizer" || pkg.version !== "4.0.0" || pkg.bin
			|| Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) return undefined;
		const { encode } = require(encoder);
		if (typeof encode !== "function") return undefined;
		// Special-token-looking user text is ordinary text. No token IDs escape.
		return (text) => encode(text, { allowedSpecial: new Set(), disallowedSpecial: new Set() }).length;
	} catch { return undefined; }
}
