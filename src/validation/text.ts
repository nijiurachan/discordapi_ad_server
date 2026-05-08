import type { FormatRules } from './rules.ts';

export type TextValidationResult = { ok: true } | { ok: false; error: string };

export function validateTitle(rules: FormatRules, title: string): TextValidationResult {
  if (title.length === 0) return { ok: false, error: 'タイトルを入力してください' };
  if (title.length > rules.titleMaxLen) {
    return {
      ok: false,
      error: `タイトルが上限を超えています (${title.length} > ${rules.titleMaxLen})`,
    };
  }
  return { ok: true };
}

export function validateBody(rules: FormatRules, body: string): TextValidationResult {
  if (body.length === 0) return { ok: false, error: '本文を入力してください' };
  if (body.length > rules.bodyMaxLen) {
    return {
      ok: false,
      error: `本文が上限を超えています (${body.length} > ${rules.bodyMaxLen})`,
    };
  }
  return { ok: true };
}

export function validateLinkUrl(rules: FormatRules, urlStr: string): TextValidationResult {
  if (urlStr.length === 0) return { ok: false, error: 'リンク URL を入力してください' };
  if (urlStr.length > rules.linkUrlMaxLen) {
    return {
      ok: false,
      error: `リンク URL が上限を超えています (${urlStr.length} > ${rules.linkUrlMaxLen})`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { ok: false, error: 'リンク URL が不正です' };
  }
  // protocol は ':' 終わりなので末尾を除去してスキーム名を得る
  const scheme = parsed.protocol.replace(/:$/, '');
  if (!rules.linkScheme.includes(scheme)) {
    return {
      ok: false,
      error: `リンク URL のスキームが許可されていません (${scheme}; 許可: ${rules.linkScheme.join(', ')})`,
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (rules.linkDomainAllowlist && rules.linkDomainAllowlist.length > 0) {
    const matched = rules.linkDomainAllowlist.some(
      (d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`),
    );
    if (!matched) {
      return {
        ok: false,
        error: `リンク URL のドメインが許可リストに含まれていません (${hostname})`,
      };
    }
  }
  if (rules.linkDomainBlocklist && rules.linkDomainBlocklist.length > 0) {
    const blocked = rules.linkDomainBlocklist.some(
      (d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`),
    );
    if (blocked) {
      return { ok: false, error: `リンク URL のドメインがブロックされています (${hostname})` };
    }
  }
  return { ok: true };
}
