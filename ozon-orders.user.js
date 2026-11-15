// ==UserScript==
// @name         Ozon — сортировка заказов
// @namespace    ozon-orders-local
// @version      1.3.0
// @description  Сортирует заказы по дате оформления или доставки и скрывает полученные.
// @author       Rico-X
// @copyright    2026 Rico-X
// @license      MIT
// @homepageURL  https://github.com/rico-x/ozon-orders-tampermonkey
// @supportURL   https://github.com/rico-x/ozon-orders-tampermonkey/issues
// @updateURL    https://raw.githubusercontent.com/rico-x/ozon-orders-tampermonkey/main/ozon-orders.user.js
// @downloadURL  https://raw.githubusercontent.com/rico-x/ozon-orders-tampermonkey/main/ozon-orders.user.js
// @match        https://www.ozon.ru/my/orderlist*
// @match        https://ozon.ru/my/orderlist*
// @run-at       document-idle
// @sandbox      DOM
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
    'use strict';

    const listSelector = '[data-widget="orderList"]';
    const sortModes = new Map([
        ['default', 'Как на Ozon'],
        ['order-desc', 'По дате заказа · сначала новые'],
        ['order-asc', 'По дате заказа · сначала старые'],
        ['delivery-asc', 'По дате доставки · сначала ранние'],
        ['delivery-desc', 'По дате доставки · сначала поздние'],
    ]);
    const months = [
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
    ];
    const datePart = new RegExp(`^(\\d{1,2})(?: (${months.join('|')}))?(?: (20\\d{2}))?(?=$|[ ,.!])`, 'i');
    const deliveredStatus = /^(?:получен[аоы]?|доставлен[аоы]?)(?=$|[ ,.!])/i;
    const waitingForPickup = /^доставлен[аоы]? (?:в (?:пункт|постамат)|на пункт)(?=$| )/i;
    const orderDates = new Map();
    let pendingOrders = [];
    let loadingDates = false;
    let requestsPaused = false;
    let unreadableDetails = 0;
    let positionedCards = new Set();
    let watchedCards = new Set();
    let hiddenCards = new Set();
    let preload = null;
    let renderQueued = false;

    GM_addStyle(`
        #tm-ozon-orders {
            box-sizing: border-box;
            position: fixed;
            right: 16px;
            bottom: 16px;
            z-index: 2147483000;
            max-width: calc(100vw - 32px);
            padding: 10px 14px;
            border: 1px solid #d4dde7;
            border-radius: 12px;
            background: #f2f5f9;
            box-shadow: 0 2px 12px #16335226;
            color: #070707;
            font-size: 14px;
            font-weight: 500;
            line-height: 1.4;
        }
        #tm-ozon-orders summary { cursor: pointer; }
        #tm-ozon-orders .tm-ozon-controls {
            display: flex;
            flex-wrap: wrap;
            gap: 12px 20px;
            align-items: center;
            max-width: 400px;
            margin-top: 10px;
        }
        #tm-ozon-orders label { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
        #tm-ozon-orders select, #tm-ozon-orders button {
            max-width: 100%; padding: 6px 8px; border: 1px solid #b9c4d3;
            border-radius: 8px; background: white; color: inherit; font: inherit;
        }
        #tm-ozon-orders select { min-width: 0; }
        #tm-ozon-orders input { margin: 0; accent-color: #005bff; }
        #tm-ozon-orders p { flex-basis: 100%; margin: 0; color: #41556b; font-size: 13px; }
        #tm-ozon-orders [hidden], [data-tm-ozon-hidden] { display: none !important; }
        [data-tm-ozon-positioned] {
            position: relative !important; top: var(--tm-ozon-offset) !important;
            overflow-anchor: none;
        }
        [data-tm-ozon-pager] {
            position: fixed !important;
            inset: 2px auto auto 2px !important;
            width: 1px !important;
            height: 1px !important;
            overflow: hidden !important;
            pointer-events: none;
        }
        [data-tm-ozon-pager="offscreen"] { top: -20px !important; }
    `);

    const panel = document.createElement('details');
    panel.id = 'tm-ozon-orders';
    panel.open = true;
    panel.innerHTML = `
        <summary>Сортировка заказов</summary>
        <div class="tm-ozon-controls">
            <label>Порядок <select></select></label>
            <label><input type="checkbox"> Скрыть доставленные</label>
            <button type="button" data-reset hidden>Сбросить</button>
            <button type="button" data-retry hidden>Повторить загрузку дат</button>
            <p role="status" hidden></p>
        </div>
    `;
    const sortControl = panel.querySelector('select');
    const hideControl = panel.querySelector('input');
    const resetControl = panel.querySelector('[data-reset]');
    const retryControl = panel.querySelector('[data-retry]');
    const statusLine = panel.querySelector('p');
    for (const [value, label] of sortModes) sortControl.add(new Option(label, value));
    // Start with native layout and all cards visible when upgrading from 1.0.
    const savedSort = GM_getValue('orderSort', 'default');
    sortControl.value = sortModes.has(savedSort) ? savedSort : 'default';
    hideControl.checked = GM_getValue('filterDelivered', false) === true;

    function saveFilters() {
        GM_setValue('orderSort', sortControl.value);
        GM_setValue('filterDelivered', hideControl.checked);
        render();
    }

    sortControl.addEventListener('change', saveFilters);
    hideControl.addEventListener('change', saveFilters);
    resetControl.addEventListener('click', () => {
        sortControl.value = 'default';
        hideControl.checked = false;
        saveFilters();
    });
    retryControl.addEventListener('click', () => {
        for (const [url, date] of orderDates) {
            if (date === null) orderDates.delete(url);
        }
        unreadableDetails = 0;
        requestsPaused = false;
        render();
    });

    function normalize(text) {
        return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function calendarDay(year, month, day) {
        const value = Date.UTC(year, month - 1, day);
        const date = new Date(value);
        return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null;
    }

    function readDatePart(text) {
        const numeric = text.match(/^(\d{1,2})\.(\d{1,2})(?:\.(20\d{2}))?(?=$|[ ,.!])/);
        if (numeric) return { day: Number(numeric[1]), month: Number(numeric[2]), year: Number(numeric[3]) };
        const match = text.match(datePart);
        return match && { day: Number(match[1]), month: months.indexOf(match[2]) + 1, year: Number(match[3]) };
    }

    function parseDate(text, today, expected = false) {
        const label = normalize(text).replace(/^[,: ]+/, '').replace(/^(?:с|к|до) /, '');
        const year = today.getFullYear();
        const month = today.getMonth() + 1;
        const day = today.getDate();
        const relative = label.match(/^(позавчера|вчера|сегодня|завтра|послезавтра)(?=$|[ ,.!])/);
        if (relative) {
            const offset = ['позавчера', 'вчера', 'сегодня', 'завтра', 'послезавтра'].indexOf(relative[1]) - 2;
            return Date.UTC(year, month - 1, day + offset);
        }

        const iso = label.match(/^(20\d{2})-(\d{2})-(\d{2})(?=$|[t ,.!])/);
        if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));

        const [startText, endText] = label.split(/\s*[-–—−]\s*| по /, 2);
        const start = readDatePart(startText);
        const end = endText && readDatePart(endText);
        if (!start || (!start.month && !end?.month)) return null;

        let startMonth = start.month || end.month;
        if (!start.month && start.day > end.day) startMonth = startMonth === 1 ? 12 : startMonth - 1;
        const crossesNewYear = end?.month && startMonth > end.month;
        let startYear = start.year || (end?.year && end.year - Number(crossesNewYear));
        if (!startYear) {
            startYear = year;
            if (expected) {
                if (startMonth - month > 6) startYear -= 1;
                if (month - startMonth > 6) startYear += 1;
            } else if (startMonth > month || (startMonth === month && start.day > day)) {
                startYear -= 1;
            }
        }
        return calendarDay(startYear, startMonth, start.day);
    }

    function readDeliveryEstimate(text, today) {
        const time = text.match(/[ ,]+(?:с )?([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
        const label = time ? text.slice(0, time.index) : text;
        const start = parseDate(label, today, true);
        if (start === null) return null;

        const endLabel = label.replace(/^20\d{2}-\d{2}-\d{2}/, '').match(/(?:[-–—−]| по )\s*(.+)$/)?.[1];
        let end = null;
        if (endLabel) {
            const part = readDatePart(endLabel);
            if (part) {
                const firstDay = new Date(start);
                const firstMonth = firstDay.getUTCMonth() + 1;
                const month = part.month || firstMonth;
                const year = part.year || firstDay.getUTCFullYear() + Number(month < firstMonth);
                end = calendarDay(year, month, part.day);
            } else {
                end = parseDate(endLabel, today, true);
            }
        }

        const currentDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
        if ((end ?? start) < currentDay) return null;
        return {
            day: Math.max(start, currentDay),
            range: end !== null && end > start,
            minutes: time ? 60 * Number(time[1]) + Number(time[2]) : null,
        };
    }

    function readCard(element, today) {
        // Ozon places the order-details link before the status and delivery block.
        const link = Array.from(element.children).find(child => child.matches('a[href*="/my/orderdetails"]'));
        if (!link) return null;
        const url = new URL(link.getAttribute('href'), location.href);
        if (url.origin !== location.origin || !/^\/my\/orderdetails\/?$/.test(url.pathname)) return null;
        url.hash = '';

        const header = link.nextElementSibling?.firstElementChild;
        const labels = Array.from(header?.children ?? [], node => normalize(node.textContent));
        const status = labels[0] ?? '';
        const delivered = deliveredStatus.test(status) && !waitingForPickup.test(status);
        const receivedDay = delivered ? parseDate(status.replace(deliveredStatus, ''), today) : null;
        let delivery = receivedDay === null ? null : { day: receivedDay, range: false, minutes: null };
        if (!delivered) {
            for (const label of labels) {
                const estimate = label.match(/^(?:ожидаем|доставим|доставят|доставка)[ ,:]+(.+)/);
                if (estimate) delivery = readDeliveryEstimate(estimate[1], today);
                else if (/^(?:сегодня|завтра|послезавтра)(?=$|[ ,.!])/.test(label)) {
                    delivery = readDeliveryEstimate(label, today);
                }
                if (delivery) break;
            }
        }
        return { element, url: url.href, delivered, delivery };
    }

    async function loadOrderDates() {
        if (loadingDates || requestsPaused || pendingOrders.length === 0) return;
        loadingDates = true;
        while (!requestsPaused && pendingOrders.length && /^\/my\/orderlist\/?$/.test(location.pathname)) {
            const url = pendingOrders.shift();
            if (orderDates.has(url)) continue;
            let date = null;
            try {
                const response = await fetch(url, {
                    credentials: 'same-origin',
                    headers: { Accept: 'text/html' },
                    redirect: 'error',
                    signal: AbortSignal.timeout(12000),
                });
                requestsPaused = [401, 403, 429].includes(response.status);
                if (response.ok) {
                    const details = document.createElement('template');
                    details.innerHTML = await response.text();
                    const headings = details.content.querySelectorAll('[data-widget="titleWithTimer"] span, [data-widget="titleWithTimer"], h1, h2');
                    for (const heading of headings) {
                        const match = normalize(heading.textContent).match(/^заказ от (.+)/);
                        if (!match) continue;
                        date = parseDate(match[1], new Date());
                        if (date !== null) break;
                    }
                }
            } catch {
                // Keep the card visible when its detail page cannot be read.
            }
            orderDates.set(url, date);
            unreadableDetails = date === null ? unreadableDetails + 1 : 0;
            if (unreadableDetails >= 3) requestsPaused = true;
            scheduleRender();
            await new Promise(resolve => setTimeout(resolve, 600));
        }
        loadingDates = false;
    }

    function clearPositions() {
        for (const element of positionedCards) {
            element.removeAttribute('data-tm-ozon-positioned');
            element.style.removeProperty('--tm-ozon-offset');
        }
        positionedCards.clear();
    }

    const resizeObserver = new ResizeObserver(scheduleRender);

    function watchCardSizes(cards) {
        const next = new Set(cards.map(card => card.element));
        for (const element of watchedCards) {
            if (!next.has(element)) resizeObserver.unobserve(element);
        }
        for (const element of next) {
            if (!watchedCards.has(element)) resizeObserver.observe(element);
        }
        watchedCards = next;
    }

    function applyFilter(cards) {
        const next = hideControl.checked ? new Set(cards.filter(card => card.delivered).map(card => card.element)) : new Set();
        for (const element of hiddenCards) {
            if (!next.has(element)) element.removeAttribute('data-tm-ozon-hidden');
        }
        for (const element of next) element.setAttribute('data-tm-ozon-hidden', '');
        hiddenCards = next;
        return cards.filter(card => !hiddenCards.has(card.element));
    }

    function stopPreloading() {
        if (!preload) return;
        clearTimeout(preload.pulse);
        clearTimeout(preload.timeout);
        preload.marker.removeAttribute('data-tm-ozon-pager');
        preload = null;
    }

    function preloadActiveOrders(paginator, firstList, count) {
        const tab = new URLSearchParams(location.search).get('selectedTab');
        const content = paginator && Array.from(paginator.children).find(child => child.contains(firstList));
        const marker = (!tab || tab === 'active') ? content?.nextElementSibling : null;
        if (!count || !marker?.firstElementChild || marker.nextElementSibling) {
            stopPreloading();
            return false;
        }
        if (preload?.marker === marker && preload.count === count) return preload.waiting;

        stopPreloading();
        const request = { marker, count, waiting: true };
        preload = request;
        // Trigger Ozon's existing scroll observer without moving the viewport or its DOM nodes.
        marker.setAttribute('data-tm-ozon-pager', 'offscreen');
        request.pulse = setTimeout(() => {
            marker.setAttribute('data-tm-ozon-pager', 'visible');
            request.timeout = setTimeout(() => {
                marker.removeAttribute('data-tm-ozon-pager');
                request.waiting = false;
                scheduleRender();
            }, 6500);
        }, 100);
        return true;
    }

    function positionCards(cards, sort, byOrder) {
        // Offset the existing cards and keep the layout boxes Ozon uses for pagination.
        const natural = cards.map(card => ({
            element: card.element,
            rect: card.element.getBoundingClientRect(),
            date: (byOrder ? orderDates.get(card.url) : card.delivery?.day) ?? null,
            range: !byOrder && card.delivery?.range === true,
            minutes: byOrder ? null : card.delivery?.minutes ?? null,
        })).filter(card => card.rect.height > 0 && card.rect.width > 0);
        if (natural.length < 2) return true;

        const first = natural[0].rect;
        const gaps = natural.slice(1).map(({ rect }, index) => rect.top - natural[index].rect.bottom);
        if (gaps.some(gap => gap < -1) || natural.some(({ rect }) =>
            Math.abs(rect.left - first.left) > 1 || Math.abs(rect.width - first.width) > 1)) return false;

        const direction = sort.endsWith('-asc') ? 1 : -1;
        const sorted = [...natural].sort((left, right) => {
            if (left.date === null) return Number(right.date !== null);
            if (right.date === null) return -1;
            const byDate = direction * (left.date - right.date);
            if (byDate || byOrder) return byDate;
            if (left.range !== right.range) return Number(left.range) - Number(right.range);
            if (left.minutes === null) return Number(right.minutes !== null);
            if (right.minutes === null) return -1;
            return direction * (left.minutes - right.minutes);
        });

        let top = first.top;
        for (const [index, { element, rect }] of sorted.entries()) {
            const offset = top - rect.top;
            if (Math.abs(offset) > 0.01) {
                element.style.setProperty('--tm-ozon-offset', `${offset}px`);
                element.setAttribute('data-tm-ozon-positioned', '');
                positionedCards.add(element);
            }
            top += rect.height + (gaps[index] ?? 0);
        }
        return true;
    }

    function render() {
        clearPositions();
        const onOrdersPage = /^\/my\/orderlist\/?$/.test(location.pathname);
        const firstList = onOrdersPage ? document.querySelector(listSelector) : null;
        const tabs = onOrdersPage && document.querySelector('[data-widget="tabsSelector"]');
        if (!firstList && !tabs) {
            panel.remove();
            pendingOrders = [];
            stopPreloading();
            applyFilter([]);
            watchCardSizes([]);
            return;
        }

        const paginator = firstList?.closest('[data-widget="paginator"]');
        const lists = paginator ? [...paginator.querySelectorAll(listSelector)] : (firstList ? [firstList] : []);
        // Inserting siblings into Ozon's root while Vue hydrates can abort the whole order list.
        if (!panel.isConnected) document.body.append(panel);

        const today = new Date();
        const cards = lists.flatMap(list => Array.from(list.children, element => readCard(element, today))).filter(Boolean);
        const preloading = preloadActiveOrders(paginator, firstList, cards.length);
        const visibleCards = preloading ? cards : applyFilter(cards);
        const sort = sortControl.value;
        const byOrder = sort.startsWith('order-');
        const orderURLs = byOrder && !preloading ? [...new Set(visibleCards.map(card => card.url))] : [];
        pendingOrders = orderURLs.filter(url => !orderDates.has(url));
        const loadingOrderDates = pendingOrders.length > 0 && !requestsPaused;
        const waitToSort = preloading || loadingOrderDates;
        watchCardSizes(waitToSort || sort === 'default' ? [] : visibleCards);
        const canSort = waitToSort || sort === 'default' || positionCards(visibleCards, sort, byOrder);

        const status = [];
        const hidden = cards.length - visibleCards.length;
        if (!cards.length) status.push('На странице пока нет доступных карточек заказов.');
        if (hidden) status.push(visibleCards.length ? `Скрыто доставленных: ${hidden}.` : 'Все загруженные заказы скрыты фильтром.');
        if (!canSort) status.push('Сортировка недоступна для этого вида ленты.');
        if (preloading) status.push(`Подгружаются актуальные заказы… Загружено ${cards.length}.`);
        else if (preload) status.push('Ozon пока не загрузил следующую порцию актуальных заказов.');
        if (!preloading && canSort && visibleCards.length && sort.startsWith('delivery-')) {
            status.push('Для действующего интервала берётся ближайший день.');
        }
        const missingDates = byOrder && (visibleCards.some(card => orderDates.get(card.url) === null)
            || (requestsPaused && pendingOrders.length > 0));
        if (loadingOrderDates) status.push(`Загружаются даты оформления… ${orderURLs.length - pendingOrders.length} из ${orderURLs.length}.`);
        if (missingDates) {
            status.push('Часть дат оформления недоступна. Эти заказы в конце списка.');
        }
        resetControl.hidden = sort === 'default' && !hideControl.checked;
        retryControl.hidden = !missingDates;
        statusLine.hidden = status.length === 0;
        const message = status.join(' ');
        if (statusLine.textContent !== message) statusLine.textContent = message;

        void loadOrderDates();
    }

    function scheduleRender() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            render();
        });
    }

    const observer = new MutationObserver(records => {
        if (records.some(record => !panel.contains(record.target))) scheduleRender();
    });

    function start() {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.addEventListener('popstate', scheduleRender);
        window.addEventListener('resize', scheduleRender);
        render();
    }

    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
})();
