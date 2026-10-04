import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

(function expandDollarVars(env: NodeJS.ProcessEnv = process.env) {
  const MAX = 3;
  for (let pass = 0; pass < MAX; pass++) {
    let changed = false;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') continue;
      if (!/\$\{[^}]+\}/.test(v)) continue;
      const next = v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name) => {
        const rep = env[name];
        if (rep === undefined) return _m;
        changed = true;
        return String(rep);
      });
      if (next !== v) env[k] = next;
    }
    if (!changed) return;
  }
})();
