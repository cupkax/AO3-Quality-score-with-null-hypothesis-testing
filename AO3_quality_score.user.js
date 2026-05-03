// ==UserScript==
// @name        AO3: Quality score 2
// @description Uses the kudos/hits ratio, number of chapters, and statistical evaluation to score and sort AO3 works. Fixes the calculation from the original script.
// @author      cupkax
// @version     1.0
// @include     http://archiveofourown.org/*
// @include     https://archiveofourown.org/*
// @license     MIT
// @grant       none
// ==/UserScript==

// AO3 ships jQuery on every page, so we use the in-page copy via the global $.
// (No @require needed — pulling in a second jQuery just bloats load.)

const CONFIG = {
    // ── Behavior ──────────────────────────────────────────────────────────
    alwaysCount: true,   // count automatically on page load
    alwaysSort: false,  // sort automatically (implies alwaysCount)
    hideHitcount: true,   // hide AO3's raw hitcount once Score is shown
    colourBackground: true,   // colour the Score cell by tier

    // ── Scoring tunables ──────────────────────────────────────────────────
    // Works with fewer kudos than this are demoted regardless of ratio.
    // A statistical floor on top of the p-value test for very small samples.
    minKudos: 11,

    // Baseline kudos/hits ratio used as the null hypothesis. ~4% is roughly
    // average across AO3.
    nullHypothesis: 0.04,

    // P-value threshold for the one-sided z-test. Works whose ratio is NOT
    // significantly above the null at this level get demoted to the bottom.
    significance: 0.05,

    // Hits are divided by chapters^chapterExponent before scoring, since
    // hits accrue per chapter visit but kudos accrue once per work.
    //   0   = no adjustment (penalises long fics)
    //   0.5 = sqrt — compromise (the original heuristic)
    //   1   = linear (over-rewards long fics)
    chapterExponent: 0.5,

    // ── Display ───────────────────────────────────────────────────────────
    thresholds: {
        low: 4,   // % separating red and yellow
        high: 7,   // % separating yellow and green
    },
    colors: {
        red: '#8b0000',
        yellow: '#994d00',
        green: '#006400',
    },
};

(($) => {
    'use strict';

    // ── Page state ────────────────────────────────────────────────────────
    let countable = false;
    let sortable = false;
    let statsPage = false;

    // ── Persistence ───────────────────────────────────────────────────────
    const SETTINGS = [
        { key: 'alwaysCount', label: 'Count automatically' },
        { key: 'alwaysSort', label: 'Sort automatically' },
        { key: 'hideHitcount', label: 'Hide hitcount' },
        { key: 'colourBackground', label: 'Colour background' },
    ];

    const storageKey = (key) => `${key}Local`;

    const loadUserSettings = () => {
        if (typeof Storage === 'undefined') return;
        SETTINGS.forEach(({ key }) => {
            const stored = localStorage.getItem(storageKey(key));
            if (stored === 'yes') CONFIG[key] = true;
            else if (stored === 'no') CONFIG[key] = false;
            // else: keep the default from CONFIG
        });
    };

    const saveSetting = (key) => {
        if (typeof Storage === 'undefined') return;
        localStorage.setItem(storageKey(key), CONFIG[key] ? 'yes' : 'no');
    };

    // ── Page detection ────────────────────────────────────────────────────
    const checkCountable = () => {
        const foundStats = $('dl.stats');
        if (!foundStats.length) return;

        if (foundStats.closest('li').is('.work, .bookmark')) {
            countable = sortable = true;
        } else if (foundStats.parents('.statistics').length) {
            countable = sortable = statsPage = true;
        } else if (foundStats.parents('dl.work').length) {
            countable = true;
        }

        if (countable) {
            injectStyles();
            addRatioMenu();
        }
    };

    // ── One-time CSS injection (lets userstyles override easily) ──────────
    const injectStyles = () => {
        if (document.getElementById('kudoshits-styles')) return;
        const style = document.createElement('style');
        style.id = 'kudoshits-styles';
        style.textContent = `
            dd.kudoshits.kh-low  { background-color: ${CONFIG.colors.red};    }
            dd.kudoshits.kh-mid  { background-color: ${CONFIG.colors.yellow}; }
            dd.kudoshits.kh-high { background-color: ${CONFIG.colors.green};  }
        `;
        document.head.appendChild(style);
    };

    // ── Statistical helpers ───────────────────────────────────────────────
    // One-sided z-test: is observed kudos/hits ratio significantly greater
    // than the null hypothesis ratio? Returns the upper-tail p-value.
    const getPValue = (hits, kudos) => {
        if (hits <= 0) return 1;
        const p0 = CONFIG.nullHypothesis;
        const observed = kudos / hits;
        const z = (observed - p0) / Math.sqrt((p0 * (1 - p0)) / hits);
        return 1 - standardNormalCDF(z);
    };

    // Standard normal CDF using the Abramowitz-Stegun erf approximation.
    // Φ(z) = ½(1 + erf(z/√2))
    const standardNormalCDF = (z) => {
        const x = z / Math.SQRT2;
        const sign = x < 0 ? -1 : 1;
        const ax = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * ax);
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
        return 0.5 * (1 + sign * erf);
    };

    // ── Scoring ───────────────────────────────────────────────────────────
    const tierClass = (percents) => {
        if (percents >= CONFIG.thresholds.high) return 'kh-high';
        if (percents >= CONFIG.thresholds.low) return 'kh-mid';
        return 'kh-low';
    };

    // Re-apply (or strip) tier classes on every already-scored work. Used
    // when the colourBackground setting is toggled at runtime.
    const refreshTierColors = () => {
        $('dd.kudoshits').each(function () {
            const $dd = $(this);
            const percents = parseFloat($dd.attr('data-score')) || 0;
            $dd.removeClass('kh-low kh-mid kh-high');
            if (CONFIG.colourBackground) $dd.addClass(tierClass(percents));
        });
    };

    const countRatio = () => {
        if (!countable) return;

        $('dl.stats').each(function () {
            const $stats = $(this);
            // Idempotent: skip works that already have a Score row
            if ($stats.find('dd.kudoshits').length) return;

            const $hits = $stats.find('dd.hits');
            const $kudos = $stats.find('dd.kudos');
            const $chapters = $stats.find('dd.chapters');

            try {
                const chaptersStr = $chapters.text().split('/')[0];
                if (!$hits.length || !$kudos.length || !chaptersStr) {
                    throw new Error('Missing required statistics');
                }

                const hits = parseInt($hits.text().replace(/,/g, ''), 10);
                const kudos = parseInt($kudos.text().replace(/,/g, ''), 10);
                const chapters = parseInt(chaptersStr, 10);

                if ([hits, kudos, chapters].some(Number.isNaN)) {
                    throw new Error('Invalid numeric values');
                }

                const adjustedHits = hits / Math.pow(chapters, CONFIG.chapterExponent);
                let percents = adjustedHits > 0 ? (100 * kudos) / adjustedHits : 0;

                // Demote works without enough evidence to evaluate
                if (kudos < CONFIG.minKudos) {
                    percents = 1;
                } else if (getPValue(adjustedHits, kudos) >= CONFIG.significance) {
                    percents = 1;
                }

                const display = percents.toFixed(1).replace(',', '.');
                const $label = $('<dt class="kudoshits">').text('Score:');
                const $value = $('<dd class="kudoshits">').text(`${display}%`).attr('data-score', percents);
                if (CONFIG.colourBackground) $value.addClass(tierClass(percents));
                $hits.after($label, $value);

                if (CONFIG.hideHitcount && !statsPage) $stats.find('.hits').hide();

                $stats.closest('li').attr('data-kudospercent', percents);
            } catch (error) {
                console.error(`AO3 Quality Score: ${error.message}`);
                $stats.closest('li').attr('data-kudospercent', 0);
            }
        });
    };

    // ── Sorting ───────────────────────────────────────────────────────────
    const sortByRatio = (ascending = false) => {
        if (!sortable) return;
        // If nothing has been scored yet (e.g. user clicked Sort with
        // alwaysCount off), count first so the sort has data to read.
        if (!$('[data-kudospercent]').length) countRatio();
        $('dl.stats').closest('li').parent().each(function () {
            const $list = $(this);
            const items = $list.children('li').get();
            items.sort((a, b) => {
                const aP = parseFloat(a.getAttribute('data-kudospercent')) || 0;
                const bP = parseFloat(b.getAttribute('data-kudospercent')) || 0;
                return ascending ? aP - bP : bP - aP;
            });
            $list.append(items);
        });
    };

    // ── Menu ──────────────────────────────────────────────────────────────
    const addRatioMenu = () => {
        const $headerMenu = $('ul.primary.navigation.actions');
        if (!$headerMenu.length) return;
        // Guard against double-mount
        if ($headerMenu.find('.kudoshits-menu').length) return;

        const $ratioMenu = $('<li class="dropdown kudoshits-menu">').html('<a>Kudos/hits</a>');
        $headerMenu.find('li.search').before($ratioMenu);

        const $dropMenu = $('<ul class="menu dropdown-menu">');
        $ratioMenu.append($dropMenu);

        $dropMenu.append(
            $('<li>').html('<a>Count on this page</a>').on('click', countRatio)
        );

        if (sortable) {
            $dropMenu.append(
                $('<li>').html('<a>Sort on this page</a>').on('click', () => sortByRatio())
            );
        }

        if (typeof Storage !== 'undefined') {
            $dropMenu.append(
                $('<li>').html(
                    '<a style="padding:0.5em 0.5em 0.25em;text-align:center;font-weight:bold;">' +
                    '— Settings (click to change): —</a>'
                )
            );

            SETTINGS.forEach(({ key, label }) => {
                const renderLabel = () => `${label}: ${CONFIG[key] ? 'YES' : 'NO'}`;
                const $btn = $('<li>').html(`<a>${renderLabel()}</a>`);
                $btn.on('click', function () {
                    CONFIG[key] = !CONFIG[key];
                    saveSetting(key);
                    $(this).find('a').text(renderLabel());
                    if (key === 'hideHitcount') {
                        $('.stats .hits').toggle(!CONFIG.hideHitcount);
                    } else if (key === 'colourBackground') {
                        refreshTierColors();
                    }
                });
                $dropMenu.append($btn);
            });
        }

        // Sort buttons on the dedicated statistics page
        if ($('#main').is('.stats-index')) {
            const $desc = $('<li>').html('<a>↓&nbsp;Kudos/hits</a>');
            const $asc = $('<li>').html('<a>↑&nbsp;Kudos/hits</a>');
            $desc.on('click', function () { sortByRatio(false); $(this).after($asc).detach(); });
            $asc.on('click', function () { sortByRatio(true); $(this).after($desc).detach(); });
            $('ul.sorting.actions li:nth-child(3)').after($desc);
        }
    };

    // ── Bootstrap ─────────────────────────────────────────────────────────
    loadUserSettings();
    checkCountable();

    // alwaysSort implies counting; otherwise sort would have nothing to read.
    if (CONFIG.alwaysCount || CONFIG.alwaysSort) {
        countRatio();
        if (CONFIG.alwaysSort) sortByRatio();
    }

})(jQuery);