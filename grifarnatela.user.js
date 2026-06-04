// ==UserScript==
// @name         Mercado Livre - Expand & Highlight
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  Expande anúncios e grifa códigos MLB da planilha no Mercado Livre
// @author       You
// @match        https://*.mercadolivre.com.br/*
// @match        https://*.mercadolibre.com/*
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
// @updateURL    https://raw.githubusercontent.com/xTiozao/grifarnatela/main/grifarnatela.user.js
// @downloadURL  https://raw.githubusercontent.com/xTiozao/grifarnatela/main/grifarnatela.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SHEET_ID = '1OuI7NszgmIdiwXW683wWaffu7FfHFBtvOqCZZ3HR1mQ';
    const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&range=A3:A5000`;

    let cachedTerms = null;
    let mutationTimer = null;
    let observer = null;

    // ── 1. Verifica se está na página de anúncios ─────────────────────────────
    function isAnunciosPage() {
        return window.location.href.includes('/lista/promos');
    }

    // ── 2. Expande botões (apenas fora da página de anúncios) ─────────────────
    function expandButtons() {
        if (isAnunciosPage()) return;

        const buttons = document.querySelectorAll('button[aria-label="Expandir anúncios"]');
        buttons.forEach(btn => {
            if (btn.getAttribute('aria-expanded') === 'false') {
                btn.setAttribute('aria-expanded', 'true');
                btn.click();
            }
        });
    }

    // ── 3. Remove grifos anteriores ───────────────────────────────────────────
    function removeHighlights() {
        document.querySelectorAll('mark.ml-highlight').forEach(mark => {
            const parent = mark.parentNode;
            if (!parent) return;
            parent.replaceChild(document.createTextNode(mark.textContent), mark);
            parent.normalize();
        });
    }

    // ── 4. Extrai apenas o número do código MLB ───────────────────────────────
    // Ex: "MLB3360066387" → "3360066387"
    function extractNumericId(raw) {
        const match = String(raw).trim().match(/(\d{7,})/);
        return match ? match[1] : null;
    }

    // ── 5. Grifa ocorrências ──────────────────────────────────────────────────
    function highlightMatches(numericIds) {
        if (!numericIds || !numericIds.length) return;

        if (!document.querySelector('style#ml-style')) {
            const style = document.createElement('style');
            style.id = 'ml-style';
            style.textContent = `
                .ml-highlight {
                    background-color: #FF4444 !important;
                    color: #fff !important;
                    border-radius: 3px;
                    padding: 0 2px;
                    font-weight: bold;
                    outline: 2px solid #CC0000;
                }
            `;
            document.head.appendChild(style);
        }

        // Regex que encontra o ID numérico precedido opcionalmente por MLB/MLA/etc ou # ou nada
        const escaped = numericIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const regex = new RegExp(
            `(?:MLB|MLA|MLM|#)?(?:${escaped.join('|')})`,
            'gi'
        );

        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    const tag = node.parentElement?.tagName?.toUpperCase();
                    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA'].includes(tag)) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    if (node.parentElement?.classList?.contains('ml-highlight')) {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);

        let count = 0;
        nodes.forEach(textNode => {
            const text = textNode.textContent;
            if (!regex.test(text)) { regex.lastIndex = 0; return; }
            regex.lastIndex = 0;

            const parts = text.split(regex);
            const matches = text.match(regex) || [];

            if (parts.length <= 1 || matches.length === 0) return;

            const frag = document.createDocumentFragment();
            parts.forEach((part, i) => {
                if (part) frag.appendChild(document.createTextNode(part));
                if (i < matches.length) {
                    const mark = document.createElement('mark');
                    mark.className = 'ml-highlight';
                    mark.textContent = matches[i];
                    frag.appendChild(mark);
                    count++;
                }
            });

            try {
                textNode.parentNode.replaceChild(frag, textNode);
            } catch (e) { /* ignora */ }
        });

        console.log(`[ML-Script] ${count} ocorrência(s) grifada(s) de vermelho.`);
    }

    // ── 6. Executa ciclo completo ─────────────────────────────────────────────
    function runCycle() {
        expandButtons();
        removeHighlights();
        highlightMatches(cachedTerms);
    }

    // ── 7. Busca planilha (só uma vez, depois usa cache) ──────────────────────
    function fetchAndRun() {
        if (cachedTerms !== null) {
            runCycle();
            return;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: SHEET_URL,
            onload: function (response) {
                try {
                    const raw = response.responseText;
                    const jsonStr = raw.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/)?.[1];
                    if (!jsonStr) throw new Error('Formato inesperado');

                    const json = JSON.parse(jsonStr);
                    const rows = json?.table?.rows || [];

                    const rawTerms = rows
                        .map(row => row?.c?.[0]?.v)
                        .filter(v => v !== null && v !== undefined && String(v).trim() !== '');

                    // Extrai apenas a parte numérica de cada código
                    cachedTerms = rawTerms
                        .map(v => extractNumericId(v))
                        .filter(Boolean);

                    console.log(`[ML-Script] ${cachedTerms.length} ID(s) carregado(s):`, cachedTerms);
                    runCycle();
                } catch (e) {
                    console.error('[ML-Script] Erro ao parsear planilha:', e);
                }
            },
            onerror: function (err) {
                console.error('[ML-Script] Erro ao buscar planilha:', err);
            }
        });
    }

    // ── 8. MutationObserver — detecta mudanças na página ─────────────────────
    function startObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver((mutations) => {
            const isOwnMutation = mutations.every(m =>
                [...m.addedNodes].every(n =>
                    n.nodeType === Node.TEXT_NODE ||
                    (n.nodeType === Node.ELEMENT_NODE && n.classList?.contains('ml-highlight'))
                )
            );
            if (isOwnMutation) return;

            clearTimeout(mutationTimer);
            mutationTimer = setTimeout(() => {
                console.log('[ML-Script] Mudança detectada, reaplicando...');
                fetchAndRun();
            }, 800);
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    // ── 9. Inicialização ──────────────────────────────────────────────────────
    window.addEventListener('load', () => {
        setTimeout(() => {
            fetchAndRun();
            startObserver();
        }, 2000);
    });

})();