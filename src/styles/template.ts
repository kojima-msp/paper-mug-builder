// .tex のコード片に値を差し込む。{{name}} を置き換える（TeX の波括弧と並んでもよい：\fpeval{{{w}}} → \fpeval{77}）。

export function fill(tpl: string, vars: Record<string, string | number> = {}): string {
  const out = tpl.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`テンプレートの値がありません：{{${name}}}`);
    return String(vars[name]);
  });
  return out.replace(/\n+$/, '');
}
