// ==UserScript==
// @name         Discord 反应用户快速查找
// @namespace    https://discord.com/
// @version      1.0.0
// @description  在“反应”弹窗中查找用户，支持全量加载/查看/复制完整名单（修复部分界面加载 0 人问题）
// @author       奈亚&ChatGPT
// @match        https://discord.com/channels/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const UI_MARK_ATTR = 'data-reaction-checker-ui';
  const HIGHLIGHT_STYLE = '2px solid #43b581';
  const SCAN_MAX_ROUNDS = 700;
  const SCAN_IDLE_BREAK_ROUNDS = 12;
  const SCAN_BASE_WAIT_MS = 120;
  const SCAN_STAGNANT_WAIT_MS = 170;
  const SCAN_TOP_RESET_WAIT_MS = 120;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizeForMatch = (s) => {
    const raw = `${s ?? ''}`;
    const normalizedRaw = raw.normalize ? raw.normalize('NFKC') : raw;
    return normalize(normalizedRaw).replace(/[\u200b-\u200d\ufeff]/g, '');
  };
  const compactIdentityToken = (s) => normalizeForMatch(s).replace(/^@+/, '').replace(/[._\-\s]+/g, '');

  function isReactionDialog(dialog) {
    if (!dialog || dialog.nodeType !== 1) return false;

    const headingElements = dialog.querySelectorAll('h1,h2,[role="heading"]');
    for (const el of headingElements) {
      const title = normalize(el.textContent);
      if (title === '反应' || title === 'reactions') return true;
    }

    const previewText = normalize((dialog.textContent || '').slice(0, 120));
    return previewText.startsWith('反应') || previewText.startsWith('reactions');
  }

  function getReactionDialog() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    return dialogs.find(isReactionDialog) || null;
  }

  function getActiveReactionFingerprint(dialog) {
    const selected = dialog.querySelector(
      '[role="tab"][aria-selected="true"], [role="listitem"][aria-selected="true"], [aria-selected="true"]',
    );
    if (!selected) return '';

    const text =
      selected.getAttribute('aria-label') || selected.innerText || selected.textContent || '';
    return normalize(text);
  }

  const rowEntryCache = new WeakMap();

  function getRowLines(row) {
    return (row.innerText || row.textContent || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  function extractUserIdFromText(text) {
    const match = (text || '').match(/(?:^|\D)(\d{16,21})(?:\D|$)/);
    return match ? match[1] : '';
  }

  function extractUserId(row) {
    if (!row) return '';

    const candidates = [
      row.getAttribute('data-user-id') || '',
      row.dataset?.userId || '',
      row.getAttribute('data-list-item-id') || '',
      row.id || '',
      row.getAttribute('aria-label') || '',
      row.getAttribute('aria-labelledby') || '',
      row.querySelector('[data-user-id]')?.getAttribute('data-user-id') || '',
      row.querySelector('a[href*="/users/"]')?.getAttribute('href') || '',
      row.querySelector('a[href*="/channels/"]')?.getAttribute('href') || '',
    ];

    for (const value of candidates) {
      const id = extractUserIdFromText(value);
      if (id) return id;
    }
    return '';
  }

  function hasAvatarLike(row) {
    return !!row.querySelector(
      [
        'img[src*="/avatars/"]',
        'img[src*="cdn.discordapp.com/avatars"]',
        'img[class*="avatar"]',
        '[class*="avatar"]',
        '[style*="background-image"][style*="cdn.discordapp.com"]',
      ].join(', '),
    );
  }

  function hasWordLikeChars(text) {
    return /[a-zA-Z0-9\u4e00-\u9fff@._-]/.test(text || '');
  }

  function isLikelyReactionCounterLines(lines) {
    if (!lines.length) return true;

    if (lines.length <= 2) {
      const hasCounterLine = lines.some((line) => isLikelyCounterLine(line));
      const allOtherPartsNonWord = lines.every(
        (line) => isLikelyCounterLine(line) || !hasWordLikeChars(line),
      );
      if (hasCounterLine && allOtherPartsNonWord) return true;
    }

    return false;
  }

  function hasUserIdentityLike(row, lines) {
    const joined = lines.join(' ');

    if (extractUserId(row) || extractUserIdFromText(joined)) return true;
    if (lines.some((line) => /(^|\s)@[\w._-]{2,}/.test(line))) return true;

    const meaningfulLines = lines.filter((line) => !isLikelyCounterLine(line) && hasWordLikeChars(line));
    return meaningfulLines.length >= 2;
  }

  function isLikelyCounterLine(line) {
    const text = (line || '').trim();
    if (!text) return true;
    const pure = text.replace(/[\s,.，]/g, '');
    return /^\d{1,8}$/.test(pure);
  }

  function looksLikeUserRow(row, dialogRect) {
    if (!row || !row.offsetParent) return false;

    const height = row.offsetHeight || row.getBoundingClientRect().height;
    if (height < 24 || height > 160) return false;

    const minWidth = Math.max(96, dialogRect.width * 0.18);
    const width = row.offsetWidth || row.getBoundingClientRect().width;
    if (width < minWidth) return false;

    const lines = getRowLines(row);
    if (!lines.length || lines.length > 8) return false;
    if (lines.every(isLikelyCounterLine)) return false;
    if (isLikelyReactionCounterLines(lines)) return false;

    const txt = lines.join(' ');
    if (!txt || txt.length > 180) return false;

    if (!hasAvatarLike(row) && !hasUserIdentityLike(row, lines)) return false;

    return true;
  }

  function looksLikeUserRowRelaxed(row, dialogRect) {
    if (!row || !row.offsetParent) return false;
    if (row.closest(`[${UI_MARK_ATTR}]`)) return false;

    const height = row.offsetHeight || row.getBoundingClientRect().height;
    if (height < 20 || height > 220) return false;

    const width = row.offsetWidth || row.getBoundingClientRect().width;
    const minWidth = Math.max(72, dialogRect.width * 0.1);
    if (width < minWidth) return false;

    const lines = getRowLines(row);
    if (!lines.length || lines.length > 10) return false;
    if (lines.every(isLikelyCounterLine) || isLikelyReactionCounterLines(lines)) return false;

    const txt = lines.join(' ');
    if (!txt || txt.length > 220) return false;

    return hasAvatarLike(row) || hasUserIdentityLike(row, lines);
  }

  function getRows(dialog, root = dialog, dialogRect = null) {
    const baseDialogRect = dialogRect || dialog.getBoundingClientRect();

    // 主路径：仅保留“像用户行”的 listitem，排除左侧 emoji 计数列表
    let rows = Array.from(root.querySelectorAll('[role="listitem"]')).filter((el) =>
      looksLikeUserRow(el, baseDialogRect),
    );
    if (rows.length) return rows;

    // 次级路径：一些版本会把用户项标记成 option/button 或 data-list-item-id
    rows = Array.from(
      root.querySelectorAll('[data-list-item-id], [role="option"], [role="button"]'),
    ).filter((el) => looksLikeUserRow(el, baseDialogRect));
    if (rows.length) return rows;

    // 兜底：结构变化时对 div 扫描，并继续用“用户行规则”过滤
    rows = Array.from(root.querySelectorAll('div')).filter((el) =>
      looksLikeUserRow(el, baseDialogRect),
    );
    if (rows.length) return rows;

    // 最终兜底：放宽规则，解决某些新 UI 下严格规则拿不到行的问题
    rows = Array.from(
      root.querySelectorAll('[role="listitem"], [data-list-item-id], [role="option"], [role="button"], div'),
    ).filter((el) => looksLikeUserRowRelaxed(el, baseDialogRect));

    return rows;
  }

  function parseRowEntry(row) {
    const quickText = normalizeForMatch(row.textContent || '');
    const rowIdentityAttr = row.getAttribute('data-list-item-id') || row.getAttribute('data-user-id') || '';
    const fingerprint = `${quickText}|${row.childElementCount}|${rowIdentityAttr}`;
    const cached = rowEntryCache.get(row);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.entry;
    }

    const userId = extractUserId(row);
    const lines = getRowLines(row);
    const normalizedLines = lines.map(normalizeForMatch).filter(Boolean);
    const matchTokens = new Set();

    for (const line of normalizedLines) {
      const noAt = line.replace(/^@+/, '');
      matchTokens.add(line);
      if (noAt) matchTokens.add(noAt);

      const compact = compactIdentityToken(line);
      if (compact) matchTokens.add(compact);
    }

    if (userId) {
      matchTokens.add(userId);
    }

    const username = lines.find((line) => line.trim().startsWith('@')) || lines[1] || '';
    const entry = {
      signature: userId || normalizedLines.slice(0, 3).join(' | '),
      displayName: lines[0] || '',
      username,
      userId,
      lines,
      normalizedLines,
      matchTokens,
    };

    rowEntryCache.set(row, { fingerprint, entry });
    return entry;
  }

  function rowMatchesEntry(entry, keyword) {
    const target = normalizeForMatch(keyword);
    if (!target) return false;

    const targetNoAt = target.replace(/^@+/, '');
    const targetCompact = compactIdentityToken(target);
    const targetId = extractUserIdFromText(targetNoAt);

    if (targetId) {
      return entry.userId === targetId || entry.matchTokens.has(targetId);
    }

    if (
      entry.matchTokens.has(target) ||
      (targetNoAt && entry.matchTokens.has(targetNoAt)) ||
      (targetCompact && entry.matchTokens.has(targetCompact))
    ) {
      return true;
    }

    if (targetNoAt.length < 3 && targetCompact.length < 3) {
      return false;
    }

    return entry.normalizedLines.some((line) => {
      const lineNoAt = line.replace(/^@+/, '');
      if (line.includes(target) || (targetNoAt && lineNoAt.includes(targetNoAt))) {
        return true;
      }

      const compactLine = compactIdentityToken(line);
      return !!targetCompact && compactLine.includes(targetCompact);
    });
  }

  function rowMatches(row, keyword) {
    return rowMatchesEntry(parseRowEntry(row), keyword);
  }

  function isPotentialScrollable(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    return el.scrollHeight - el.clientHeight > 32;
  }

  function canScrollByCode(el) {
    const maxScrollTop = el.scrollHeight - el.clientHeight;
    if (maxScrollTop <= 1) return false;

    const prev = el.scrollTop;
    const next = Math.min(maxScrollTop, prev + 12);
    el.scrollTop = next;
    const moved = Math.abs(el.scrollTop - prev) > 0;
    el.scrollTop = prev;

    return moved || prev > 0;
  }

  const dialogScanCache = new WeakMap();

  function getScrollableContainer(dialog) {
    const cached = dialogScanCache.get(dialog)?.scroller;
    if (cached && dialog.contains(cached) && document.contains(cached) && isPotentialScrollable(cached)) {
      return cached;
    }

    const rows = getRows(dialog);
    const scoreMap = new Map();

    // 从所有用户行向上找可滚动祖先，再按命中次数评分
    for (const row of rows) {
      let depth = 0;
      let p = row.parentElement;
      while (p && p !== dialog) {
        if (isPotentialScrollable(p) && canScrollByCode(p)) {
          const score = Math.max(1, 30 - depth);
          scoreMap.set(p, (scoreMap.get(p) || 0) + score);
        }
        depth++;
        p = p.parentElement;
      }
    }

    if (scoreMap.size) {
      let best = null;
      let bestScore = -1;

      for (const [el, hitScore] of scoreMap.entries()) {
        const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
        const total = hitScore * 1_000_000 + maxScroll;
        if (total > bestScore) {
          best = el;
          bestScore = total;
        }
      }

      if (best) {
        dialogScanCache.set(dialog, { scroller: best });
        return best;
      }
    }

    // 兜底：全量候选里按“包含行数 + 可滚动距离”评分
    const candidates = Array.from(dialog.querySelectorAll('*')).filter(
      (el) => isPotentialScrollable(el) && canScrollByCode(el),
    );

    let fallbackBest = null;
    let fallbackBestScore = -1;

    for (const el of candidates) {
      const containedRows = rows.filter((row) => el.contains(row)).length;
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      const score = containedRows * 1_000_000 + maxScroll;
      if (score > fallbackBestScore) {
        fallbackBest = el;
        fallbackBestScore = score;
      }
    }

    dialogScanCache.set(dialog, { scroller: fallbackBest || null });
    return fallbackBest;
  }

  function clearHighlight(dialog) {
    const scroller = getScrollableContainer(dialog);
    const rows = scroller ? getRows(dialog, scroller) : getRows(dialog);

    for (const row of rows) {
      row.style.outline = '';
      row.style.borderRadius = '';
      row.style.background = '';
    }
  }

  function markFound(row) {
    row.style.outline = HIGHLIGHT_STYLE;
    row.style.borderRadius = '8px';
    row.style.background = 'rgba(67,181,129,0.15)';
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function collectRows(dialog, target, userMap, scroller = null, dialogRect = null) {
    const scopedRows = scroller ? getRows(dialog, scroller, dialogRect) : [];
    const rows = scopedRows.length ? scopedRows : getRows(dialog, dialog, dialogRect);
    let matched = null;
    let newSeen = 0;

    for (const row of rows) {
      const entry = parseRowEntry(row);

      if (!matched && target && rowMatchesEntry(entry, target)) {
        matched = row;
      }

      if (entry.signature && !userMap.has(entry.signature)) {
        userMap.set(entry.signature, entry);
        newSeen++;
      }
    }

    return { rows, matched, newSeen };
  }

  function triggerScroll(scroller, rows, roundIndex = 0, stagnantRounds = 0) {
    const lastRow = rows[rows.length - 1] || null;
    const beforeTop = scroller ? scroller.scrollTop : 0;
    const beforeHeight = scroller ? scroller.scrollHeight : 0;

    // 首轮/卡住时再触发末行滚动，减少每轮强制布局
    if (lastRow && (!scroller || roundIndex < 2 || stagnantRounds >= 2)) {
      lastRow.scrollIntoView({ behavior: 'auto', block: 'end' });
    }

    if (scroller) {
      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const step = Math.max(180, Math.floor(scroller.clientHeight * 0.95));
      scroller.scrollTop = Math.min(beforeTop + step, maxScrollTop);

      // 只有 scrollTop 没动时才补 wheel，避免每轮额外事件开销
      if (Math.abs(scroller.scrollTop - beforeTop) <= 1) {
        try {
          scroller.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: step,
              bubbles: true,
              cancelable: true,
            }),
          );
        } catch (_) {
          // ignore
        }
      }
    } else if (lastRow) {
      try {
        lastRow.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: 800,
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch (_) {
        // ignore
      }
    }

    return { beforeTop, beforeHeight };
  }

  function isNearBottom(scroller) {
    if (!scroller) return true;
    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
  }

  async function scanReactionUsers(
    dialog,
    statusEl,
    { target = '', stopWhenFound = false, mode = 'search' } = {},
  ) {
    const displayTarget = (target || '').trim();
    const normalizedTarget = normalizeForMatch(target || '');
    const scroller = getScrollableContainer(dialog);
    const dialogRect = dialog.getBoundingClientRect();
    const userMap = new Map();
    let stagnantRounds = 0;

    // 回到顶部，保证“全量扫描”从头开始
    if (scroller) {
      scroller.scrollTop = 0;
      await sleep(SCAN_TOP_RESET_WAIT_MS);
    }

    for (let i = 0; i < SCAN_MAX_ROUNDS; i++) {
      const { rows, matched, newSeen } = collectRows(
        dialog,
        normalizedTarget,
        userMap,
        scroller,
        dialogRect,
      );

      if (matched && stopWhenFound) {
        return { foundRow: matched, userMap };
      }

      if (mode === 'load') {
        statusEl.textContent = `正在加载全部名单（已扫描 ${userMap.size} 人）`;
      } else {
        statusEl.textContent = `正在查找：${displayTarget}（已扫描 ${userMap.size} 人）`;
      }
      statusEl.style.color = '#f0b232';

      const { beforeTop, beforeHeight } = triggerScroll(scroller, rows, i, stagnantRounds);
      const waitMs = stagnantRounds >= 2 ? SCAN_STAGNANT_WAIT_MS : SCAN_BASE_WAIT_MS;
      await sleep(waitMs);

      const moved = scroller
        ? Math.abs(scroller.scrollTop - beforeTop) > 1 || scroller.scrollHeight !== beforeHeight
        : false;

      // 核心判定：必须出现“新用户”才算有实质进展
      if (newSeen > 0 || moved) {
        stagnantRounds = 0;
      } else {
        stagnantRounds++;
      }

      if (!scroller && stagnantRounds >= 6) break;
      if (!rows.length && stagnantRounds >= 6) break;
      if (isNearBottom(scroller) && stagnantRounds >= SCAN_IDLE_BREAK_ROUNDS) break;
    }

    return { foundRow: null, userMap };
  }

  function formatUserList(userMap) {
    return Array.from(userMap.values()).map((entry, idx) => {
      const left = entry.displayName || '(无昵称)';
      const right = entry.username ? ` @${entry.username.replace(/^@/, '')}` : '';
      return `${idx + 1}. ${left}${right}`;
    });
  }

  function findEntryInMap(userMap, keyword) {
    if (!userMap || !userMap.size) return null;
    for (const entry of userMap.values()) {
      if (rowMatchesEntry(entry, keyword)) return entry;
    }
    return null;
  }

  async function copyText(text) {
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // fallback
    }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  async function findUser(dialog, keyword, statusEl, cachedUserMap = null) {
    clearHighlight(dialog);

    const target = (keyword || '').trim();
    if (!target) {
      statusEl.textContent = '请输入用户名 / 昵称 / ID';
      statusEl.style.color = '#faa61a';
      return { list: [], userMap: new Map(), found: false, complete: false };
    }

    // 如果已经有“全量名单缓存”，优先直接在缓存里查，避免再次误滚动
    if (cachedUserMap && cachedUserMap.size) {
      const foundEntry = findEntryInMap(cachedUserMap, target);

      // 如果目标正好在当前可见行里，顺手高亮
      const scroller = getScrollableContainer(dialog);
      const visibleRows = scroller ? getRows(dialog, scroller) : getRows(dialog);
      const visibleRow = visibleRows.find((row) => rowMatches(row, target));
      if (visibleRow) {
        markFound(visibleRow);
      }

      const list = formatUserList(cachedUserMap);
      if (foundEntry) {
        statusEl.textContent = `✅ 在全量名单中找到：${target}（共 ${list.length} 人）`;
        statusEl.style.color = '#43b581';
      } else {
        statusEl.textContent = `❌ 在全量名单中未找到：${target}（共 ${list.length} 人）`;
        statusEl.style.color = '#ed4245';
      }

      return { list, userMap: cachedUserMap, found: !!foundEntry, complete: true };
    }

    const { foundRow, userMap } = await scanReactionUsers(dialog, statusEl, {
      target,
      stopWhenFound: true,
      mode: 'search',
    });

    const list = formatUserList(userMap);

    if (foundRow) {
      markFound(foundRow);
      statusEl.textContent = `✅ 找到了：${target} 点过反应（已扫描 ${list.length} 人）`;
      statusEl.style.color = '#43b581';
    } else {
      statusEl.textContent = `❌ 未找到：${target}（已扫描 ${list.length} 人）`;
      statusEl.style.color = '#ed4245';
    }

    return { list, userMap, found: !!foundRow, complete: !foundRow };
  }

  async function loadAllUsers(dialog, statusEl) {
    clearHighlight(dialog);

    const { userMap } = await scanReactionUsers(dialog, statusEl, {
      mode: 'load',
      stopWhenFound: false,
    });

    const list = formatUserList(userMap);
    if (!list.length) {
      statusEl.textContent = '⚠️ 未识别到用户行，请先切到具体反应标签后再试';
      statusEl.style.color = '#faa61a';
    } else {
      statusEl.textContent = `✅ 已加载完成，共 ${list.length} 人`;
      statusEl.style.color = '#43b581';
    }
    return { list, userMap };
  }

  function mountUI(dialog) {
    if (dialog.querySelector(`[${UI_MARK_ATTR}="1"]`)) return;

    const wrapper = document.createElement('div');
    wrapper.setAttribute(UI_MARK_ATTR, '1');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '8px';
    wrapper.style.width = '100%';
    wrapper.style.boxSizing = 'border-box';
    wrapper.style.padding = '8px 16px 10px';
    wrapper.style.borderBottom = '1px solid rgba(255,255,255,0.08)';

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.width = '100%';
    controls.style.flexWrap = 'wrap';
    controls.style.rowGap = '6px';
    controls.style.alignItems = 'center';
    controls.style.gap = '8px';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '输入用户名 / 昵称 / ID（例如：orla.）';
    input.style.flex = '1 1 220px';
    input.style.minWidth = '140px';
    input.style.boxSizing = 'border-box';
    input.style.height = '32px';
    input.style.border = '1px solid rgba(255,255,255,0.15)';
    input.style.borderRadius = '8px';
    input.style.background = 'rgba(255,255,255,0.06)';
    input.style.color = '#fff';
    input.style.padding = '0 10px';
    input.style.outline = 'none';

    const findBtn = document.createElement('button');
    findBtn.textContent = '查找';
    findBtn.style.height = '32px';
    findBtn.style.padding = '0 12px';
    findBtn.style.border = '0';
    findBtn.style.borderRadius = '8px';
    findBtn.style.display = 'inline-flex';
    findBtn.style.alignItems = 'center';
    findBtn.style.justifyContent = 'center';
    findBtn.style.whiteSpace = 'nowrap';
    findBtn.style.lineHeight = '1';
    findBtn.style.flex = '0 0 auto';
    findBtn.style.cursor = 'pointer';
    findBtn.style.background = '#5865f2';
    findBtn.style.color = '#fff';
    findBtn.style.fontWeight = '600';

    const loadAllBtn = document.createElement('button');
    loadAllBtn.textContent = '全量加载';
    loadAllBtn.style.height = '32px';
    loadAllBtn.style.padding = '0 12px';
    loadAllBtn.style.border = '0';
    loadAllBtn.style.borderRadius = '8px';
    loadAllBtn.style.display = 'inline-flex';
    loadAllBtn.style.alignItems = 'center';
    loadAllBtn.style.justifyContent = 'center';
    loadAllBtn.style.whiteSpace = 'nowrap';
    loadAllBtn.style.lineHeight = '1';
    loadAllBtn.style.flex = '0 0 auto';
    loadAllBtn.style.cursor = 'pointer';
    loadAllBtn.style.background = '#3ba55c';
    loadAllBtn.style.color = '#fff';
    loadAllBtn.style.fontWeight = '600';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = '复制名单';
    copyBtn.style.height = '32px';
    copyBtn.style.padding = '0 12px';
    copyBtn.style.border = '0';
    copyBtn.style.borderRadius = '8px';
    copyBtn.style.display = 'inline-flex';
    copyBtn.style.alignItems = 'center';
    copyBtn.style.justifyContent = 'center';
    copyBtn.style.whiteSpace = 'nowrap';
    copyBtn.style.lineHeight = '1';
    copyBtn.style.flex = '0 0 auto';
    copyBtn.style.cursor = 'pointer';
    copyBtn.style.background = '#4f545c';
    copyBtn.style.color = '#fff';
    copyBtn.style.fontWeight = '600';

    const status = document.createElement('div');
    status.style.fontSize = '12px';
    status.style.opacity = '0.95';
    status.style.lineHeight = '1.4';
    status.style.minHeight = '16px';
    status.style.wordBreak = 'break-word';

    const listArea = document.createElement('textarea');
    listArea.style.boxSizing = 'border-box';
    listArea.readOnly = true;
    listArea.placeholder = '点击“全量加载”后，这里会显示完整名单';
    listArea.style.display = 'none';
    listArea.style.width = '100%';
    listArea.style.minHeight = '170px';
    listArea.style.maxHeight = '260px';
    listArea.style.resize = 'vertical';
    listArea.style.border = '1px solid rgba(255,255,255,0.15)';
    listArea.style.borderRadius = '8px';
    listArea.style.background = 'rgba(0,0,0,0.22)';
    listArea.style.color = '#fff';
    listArea.style.padding = '8px 10px';
    listArea.style.outline = 'none';
    listArea.style.fontSize = '12px';
    listArea.style.lineHeight = '1.5';

    controls.appendChild(input);
    controls.appendChild(findBtn);
    controls.appendChild(loadAllBtn);
    controls.appendChild(copyBtn);

    wrapper.appendChild(controls);
    wrapper.appendChild(status);
    wrapper.appendChild(listArea);

    const heading = dialog.querySelector('h1,h2,[role="heading"]');
    const headingBlock = heading?.closest('div');

    if (headingBlock?.parentElement) {
      headingBlock.parentElement.insertBefore(wrapper, headingBlock.nextSibling);
    } else {
      dialog.prepend(wrapper);
    }

    let running = false;
    let cachedList = [];
    let cachedUserMap = new Map();
    let cachedReactionFingerprint = '';

    const syncCacheWithActiveReaction = () => {
      const currentFp = getActiveReactionFingerprint(dialog);

      if (
        cachedReactionFingerprint &&
        currentFp &&
        cachedReactionFingerprint !== currentFp
      ) {
        cachedList = [];
        cachedUserMap = new Map();
        listArea.value = '';
        listArea.style.display = 'none';
      }
      return currentFp;
    };

    const setBusy = (busy) => {
      running = busy;
      input.disabled = busy;
      findBtn.disabled = busy;
      loadAllBtn.disabled = busy;
      copyBtn.disabled = busy;
      findBtn.style.opacity = busy ? '0.7' : '1';
      loadAllBtn.style.opacity = busy ? '0.7' : '1';
      copyBtn.style.opacity = busy ? '0.7' : '1';
    };

    const runFind = async () => {
      if (running) return;
      setBusy(true);
      try {
        const currentFp = syncCacheWithActiveReaction();
        const result = await findUser(dialog, input.value, status, cachedUserMap);
        cachedList = result.list;
        if (result.complete && result.userMap && result.userMap.size) {
          cachedUserMap = result.userMap;
        }

        if (cachedUserMap.size && currentFp) {
          cachedReactionFingerprint = currentFp || cachedReactionFingerprint;
        }
      } catch (err) {
        status.textContent = `❌ 查找失败：${err?.message || err}`;
        status.style.color = '#ed4245';
      } finally {
        setBusy(false);
      }
    };

    const runLoadAll = async () => {
      if (running) return;
      setBusy(true);
      try {
        const currentFp = syncCacheWithActiveReaction();
        const result = await loadAllUsers(dialog, status);
        cachedList = result.list;
        cachedUserMap = result.userMap || new Map();
        cachedReactionFingerprint = currentFp || cachedReactionFingerprint;
        listArea.value = cachedList.join('\n');
        listArea.style.display = 'block';
      } catch (err) {
        status.textContent = `❌ 加载失败：${err?.message || err}`;
        status.style.color = '#ed4245';
      } finally {
        setBusy(false);
      }
    };

    const runCopy = async () => {
      if (running) return;
      if (!cachedList.length) {
        status.textContent = '请先点“全量加载”拿到完整名单';
        status.style.color = '#faa61a';
        return;
      }

      const ok = await copyText(cachedList.join('\n'));
      if (ok) {
        status.textContent = `✅ 已复制 ${cachedList.length} 人名单到剪贴板`;
        status.style.color = '#43b581';
      } else {
        status.textContent = '❌ 复制失败（浏览器权限限制）';
        status.style.color = '#ed4245';
      }
    };

    findBtn.addEventListener('click', runFind);
    loadAllBtn.addEventListener('click', runLoadAll);
    copyBtn.addEventListener('click', runCopy);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runFind();
    });

    setTimeout(() => input.focus(), 50);
  }

  function bootstrap() {
    const dialog = getReactionDialog();
    if (!dialog) return;
    mountUI(dialog);
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      bootstrap();
    }, 80);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  bootstrap();
})();
