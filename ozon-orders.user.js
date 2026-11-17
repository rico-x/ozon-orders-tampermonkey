// ==UserScript==
// @name         Ozon — сортировка заказов
// @namespace    ozon-orders-local
// @version      1.5.0
// @description  Поиск по заказам Ozon, сортировка и фильтры для актуальных заказов.
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
    const cancelledStatus = /^(?:заказ )?отмен[её]н[аоы]?(?=$|[ ,.!:])/;
    const orderDetails = new Map();
    const searches = { active: '', archive: '' };
    let displayedTab = null;
    let pendingOrders = [];
    let retryOrders = [];
    let loadingDetails = false;
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
        #tm-ozon-orders .tm-ozon-controls, #tm-ozon-orders form {
            display: flex;
            flex-wrap: wrap;
            gap: 12px 20px;
            align-items: center;
            max-width: 400px;
            margin-top: 10px;
        }
        #tm-ozon-orders form { gap: 6px; }
        #tm-ozon-orders form label { flex-basis: 100%; }
        #tm-ozon-orders label { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; }
        #tm-ozon-orders select, #tm-ozon-orders button, #tm-ozon-orders input[type="search"] {
            max-width: 100%; padding: 6px 8px; border: 1px solid #b9c4d3;
            border-radius: 8px; background: white; color: inherit; font: inherit;
        }
        #tm-ozon-orders input[type="search"] { flex: 1 1 210px; min-width: 0; }
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
    panel.innerHTML = `
        <summary>Сортировка и поиск</summary>
        <form role="search" aria-label="Поиск по заказам Ozon">
            <label for="tm-ozon-search">Поиск по заказам</label>
            <input id="tm-ozon-search" type="search" placeholder="Товар, номер или статус" autocomplete="off">
            <button type="submit">Найти</button>
            <button type="button" data-clear hidden>Очистить</button>
        </form>
        <div class="tm-ozon-controls" data-active-controls>
            <label>Порядок <select></select></label>
            <label><input type="checkbox" name="hide-delivered"> Скрыть доставленные</label>
            <label><input type="checkbox" name="hide-cancelled"> Скрыть отменённые</label>
            <button type="button" data-reset hidden>Сбросить</button>
        </div>
        <div class="tm-ozon-controls" data-feedback hidden>
            <p role="status"></p>
            <button type="button" data-retry hidden>Повторить загрузку деталей</button>
        </div>
    `;
    const panelTitle = panel.querySelector('summary');
    const searchForm = panel.querySelector('form');
    const searchInput = searchForm.querySelector('input');
    const clearSearch = searchForm.querySelector('[data-clear]');
    const activeControls = panel.querySelector('[data-active-controls]');
    const sortControl = panel.querySelector('select');
    const hideDeliveredControl = panel.querySelector('[name="hide-delivered"]');
    const hideCancelledControl = panel.querySelector('[name="hide-cancelled"]');
    const resetControl = panel.querySelector('[data-reset]');
    const retryControl = panel.querySelector('[data-retry]');
    const feedback = panel.querySelector('[data-feedback]');
    const statusLine = panel.querySelector('p');
    for (const [value, label] of sortModes) sortControl.add(new Option(label, value));
    // Start with native layout and all cards visible when upgrading from 1.0.
    const savedSort = GM_getValue('orderSort', 'default');
    sortControl.value = sortModes.has(savedSort) ? savedSort : 'default';
    hideDeliveredControl.checked = GM_getValue('filterDelivered', false) === true;
    hideCancelledControl.checked = GM_getValue('filterCancelled', false) === true;

    function currentTab() {
        const tab = new URLSearchParams(location.search).get('selectedTab');
        return !tab || tab === 'active' ? 'active' : 'archive';
    }

    searchForm.addEventListener('submit', event => {
        event.preventDefault();
        searches[currentTab()] = searchInput.value.trim();
        render();
    });
    clearSearch.addEventListener('click', () => {
        searchInput.value = '';
        searches[currentTab()] = '';
        render();
        searchInput.focus();
    });
    searchInput.addEventListener('input', () => {
        clearSearch.hidden = !searchInput.value && !searches[currentTab()];
        if (!searchInput.value && searches[currentTab()]) {
            searches[currentTab()] = '';
            render();
        }
    });

    function saveFilters() {
        GM_setValue('orderSort', sortControl.value);
        GM_setValue('filterDelivered', hideDeliveredControl.checked);
        GM_setValue('filterCancelled', hideCancelledControl.checked);
        render();
    }

    sortControl.addEventListener('change', saveFilters);
    hideDeliveredControl.addEventListener('change', saveFilters);
    hideCancelledControl.addEventListener('change', saveFilters);
    resetControl.addEventListener('click', () => {
        sortControl.value = 'default';
        hideDeliveredControl.checked = false;
        hideCancelledControl.checked = false;
        saveFilters();
    });
    retryControl.addEventListener('click', () => {
        for (const key of retryOrders) orderDetails.delete(key);
        unreadableDetails = 0;
        requestsPaused = false;
        stopPreloading();
        render();
    });

    function normalize(text) {
        return (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function normalizeSearch(text) {
        return normalize(text).replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
        const cancelled = cancelledStatus.test(status);
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
        const number = url.searchParams.get('order') ?? '';
        return {
            element, url: url.href, key: number || url.href, number, delivered, cancelled, delivery,
            searchText: normalizeSearch(`${number} ${status}`),
        };
    }

    function readOrderDetails(html) {
        const details = document.createElement('template');
        details.innerHTML = html;
        const content = details.content;
        const headings = content.querySelectorAll('[data-widget="titleWithTimer"] span, [data-widget="titleWithTimer"], h1, h2');
        let date = null;
        for (const heading of headings) {
            const match = normalize(heading.textContent).match(/^заказ от (.+)/);
            if (!match) continue;
            date = parseDate(match[1], new Date());
            if (date !== null) break;
        }

        const items = content.querySelectorAll(
            '[data-widget="shipmentWidget"] .tsCompact500Medium, [data-widget="orderDetailsContainer"] a[href*="/product/"]',
        );
        const products = normalizeSearch(Array.from(items, item => item.textContent).join(' ')) || null;
        return { date, products };
    }

    async function loadOrderDetails() {
        if (loadingDetails || requestsPaused || pendingOrders.length === 0) return;
        loadingDetails = true;
        while (!requestsPaused && pendingOrders.length && /^\/my\/orderlist\/?$/.test(location.pathname)) {
            const { key, url } = pendingOrders.shift();
            if (orderDetails.has(key)) continue;
            let details = null;
            try {
                const response = await fetch(url, {
                    credentials: 'same-origin',
                    headers: { Accept: 'text/html' },
                    redirect: 'error',
                    signal: AbortSignal.timeout(12000),
                });
                requestsPaused = [401, 403, 429].includes(response.status);
                if (response.ok) details = readOrderDetails(await response.text());
            } catch {
                // Leave a failed entry in the cache until the user retries.
            }
            orderDetails.set(key, details);
            unreadableDetails = details?.date != null || details?.products ? 0 : unreadableDetails + 1;
            if (unreadableDetails >= 3) requestsPaused = true;
            scheduleRender();
            await new Promise(resolve => setTimeout(resolve, 600));
        }
        loadingDetails = false;
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

    function applyVisibility(cards, visibleCards) {
        const visible = new Set(visibleCards);
        const next = new Set(cards.filter(card => !visible.has(card)).map(card => card.element));
        for (const element of hiddenCards) {
            if (!next.has(element)) element.removeAttribute('data-tm-ozon-hidden');
        }
        for (const element of next) {
            if (!hiddenCards.has(element)) element.setAttribute('data-tm-ozon-hidden', '');
        }
        hiddenCards = next;
    }

    function stopPreloading() {
        if (!preload) return;
        clearTimeout(preload.pulse);
        clearTimeout(preload.timeout);
        preload.marker.removeAttribute('data-tm-ozon-pager');
        preload = null;
    }

    function preloadOrders(paginator, firstList, count, enabled) {
        const content = enabled && paginator && Array.from(paginator.children).find(child => child.contains(firstList));
        const marker = content?.nextElementSibling;
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
            date: (byOrder ? orderDetails.get(card.key)?.date : card.delivery?.day) ?? null,
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
            displayedTab = null;
            pendingOrders = [];
            stopPreloading();
            applyVisibility([], []);
            watchCardSizes([]);
            return;
        }

        const tab = currentTab();
        const isActive = tab === 'active';
        if (displayedTab !== tab) {
            displayedTab = tab;
            searchInput.value = searches[tab];
            activeControls.hidden = !isActive;
            panelTitle.textContent = isActive ? 'Сортировка и поиск' : 'Поиск по завершённым';
            stopPreloading();
        }
        const paginator = firstList?.closest('[data-widget="paginator"]');
        const lists = paginator ? [...paginator.querySelectorAll(listSelector)] : (firstList ? [firstList] : []);
        // Inserting siblings into Ozon's root while Vue hydrates can abort the whole order list.
        if (!panel.isConnected) {
            panel.open = false;
            document.body.append(panel);
        }

        const today = new Date();
        const cards = lists.flatMap(list => Array.from(list.children, element => readCard(element, today))).filter(Boolean);
        const query = searches[tab];
        const words = normalizeSearch(query).split(' ').filter(Boolean);
        const searching = words.length > 0;
        const orderNumber = /^(?:[№#]\s*)?\d{7,}(?:[\s–—-]+\d+)*$/.test(query) ? query.replace(/\D/g, '') : '';
        const preloading = preloadOrders(paginator, firstList, cards.length, isActive || searching);
        const useStatusFilters = isActive && (!preloading || searching);
        const candidates = cards.filter(card => !useStatusFilters || !(
            (hideDeliveredControl.checked && card.delivered) || (hideCancelledControl.checked && card.cancelled)
        ));

        const visibleCards = [];
        const searchPending = [];
        const searchFailed = [];
        for (const card of candidates) {
            if (!searching || (orderNumber ? card.number.replace(/\D/g, '').includes(orderNumber)
                : words.every(word => card.searchText.includes(word)))) {
                visibleCards.push(card);
            } else if (!orderNumber) {
                const products = orderDetails.get(card.key)?.products;
                if (!orderDetails.has(card.key)) searchPending.push(card);
                else if (!products) searchFailed.push(card);
                else if (words.every(word => card.searchText.includes(word) || products.includes(word))) visibleCards.push(card);
            }
        }
        applyVisibility(cards, visibleCards);

        const sort = isActive ? sortControl.value : 'default';
        const byOrder = sort.startsWith('order-');
        const dateOrders = byOrder && !preloading ? visibleCards : [];
        const datePending = dateOrders.filter(card => !orderDetails.has(card.key));
        const dateFailed = dateOrders.filter(card => orderDetails.has(card.key) && orderDetails.get(card.key)?.date == null);
        pendingOrders = Array.from(new Map([...datePending, ...searchPending].map(card => [card.key, card])).values());
        retryOrders = [...new Set([...searchFailed, ...dateFailed].map(card => card.key))];
        const loadingOrderDates = datePending.length > 0 && !requestsPaused;
        const loadingSearch = searchPending.length > 0 && !requestsPaused;
        const waitToSort = preloading || loadingOrderDates || loadingSearch;
        watchCardSizes(waitToSort || sort === 'default' ? [] : visibleCards);
        const canSort = waitToSort || sort === 'default' || positionCards(visibleCards, sort, byOrder);

        const status = [];
        const hidden = cards.length - visibleCards.length;
        if (searching) status.push(`Найдено заказов: ${visibleCards.length}.`);
        else if (!cards.length) status.push('На странице пока нет доступных карточек заказов.');
        else if (hidden) status.push(visibleCards.length ? `Скрыто заказов: ${hidden}.` : 'Все загруженные заказы скрыты фильтрами.');
        if (!canSort) status.push('Сортировка недоступна для этого вида ленты.');
        if (preloading) status.push(`Подгружаются заказы… Загружено ${cards.length}.`);
        else if (preload) status.push('Ozon пока не загрузил следующую страницу заказов.');
        if (!preloading && canSort && visibleCards.length && sort.startsWith('delivery-')) {
            status.push('Для действующего интервала берётся ближайший день.');
        }
        const missingDates = dateFailed.length > 0 || (requestsPaused && datePending.length > 0);
        const missingSearch = searchFailed.length + (requestsPaused ? searchPending.length : 0);
        if (loadingSearch) status.push(`Проверено заказов: ${candidates.length - searchPending.length} из ${candidates.length}.`);
        if (missingSearch) status.push(`Не удалось проверить названия в ${missingSearch} заказах.`);
        if (loadingOrderDates) status.push(`Загружаются даты оформления… ${dateOrders.length - datePending.length} из ${dateOrders.length}.`);
        if (missingDates) {
            status.push('Часть дат оформления недоступна. Эти заказы в конце списка.');
        }
        clearSearch.hidden = !searchInput.value && !query;
        resetControl.hidden = sort === 'default' && !hideDeliveredControl.checked && !hideCancelledControl.checked;
        retryControl.hidden = !missingDates && !missingSearch && (!searching || !preload || preloading);
        feedback.hidden = status.length === 0;
        const message = status.join(' ');
        if (statusLine.textContent !== message) statusLine.textContent = message;

        void loadOrderDetails();
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
