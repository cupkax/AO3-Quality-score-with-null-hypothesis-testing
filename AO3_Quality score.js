// ==UserScript==
// @name        AO3: Quality Score Improved
// @description Calculates and displays quality scores for AO3 works with customizable options
// @namespace   https://greasyfork.org/scripts/3144-ao3-kudos-hits-ratio
// @author      Min (Extensive modifications by Assistant)
// @version     6.1
// @grant       GM_addStyle
// @grant       GM_getValue
// @grant       GM_setValue
// @require     https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @include     http://archiveofourown.org/*
// @include     https://archiveofourown.org/*
// @license     MIT
// ==/UserScript==

(function ($) {
    'use strict';

    // Configuration
    const CONFIG = {
        weights: {
            kudosHitRatio: 50,
            chapterAdjustment: 0.05,
            commentEngagement: 20,
            bookmarkScore: 30,
            wordCountFactor: 0.5,
            timeDecayHalfLife: 365 // days
        },
        colorThresholds: {
            low: 30,
            medium: 60
        },
        options: {
            autoSort: GM_getValue('autoSort', false),
            showScores: GM_getValue('showScores', true),
            hideWorks: GM_getValue('hideWorks', false),
            hideThreshold: GM_getValue('hideThreshold', 20)
        }
    };

    // CSS Styles
    GM_addStyle(`
      .quality-score {
        font-weight: bold;
        padding: 2px 5px;
        border-radius: 3px;
        margin-left: 10px;
      }
      .quality-score-low { background-color: #ffcccb; color: #8b0000; }
      .quality-score-medium { background-color: #ffffa1; color: #8b8b00; }
      .quality-score-high { background-color: #90EE90; color: #006400; }
      .work-stats { display: flex; align-items: center; }
      .work-stats > dd { margin-right: 10px; }
    `);

    // Core Functions
    const calculateQualityScore = (stats) => {
        if (stats.hits === 0) return 0;

        const baseScore = (stats.kudos / Math.sqrt(stats.hits)) * CONFIG.weights.kudosHitRatio;
        const chapterAdjustment = 1 + (stats.chapters - 1) * CONFIG.weights.chapterAdjustment;
        const commentBonus = (stats.comments / stats.hits) * CONFIG.weights.commentEngagement;
        const bookmarkBonus = (stats.bookmarks / stats.hits) * CONFIG.weights.bookmarkScore;
        const wordCountFactor = Math.log(stats.wordCount) / Math.log(10000) * CONFIG.weights.wordCountFactor;

        const daysSincePublish = (new Date() - stats.publishDate) / (1000 * 60 * 60 * 24);
        const timeDecayFactor = Math.exp(-daysSincePublish / CONFIG.weights.timeDecayHalfLife);

        const score = ((baseScore * chapterAdjustment + commentBonus + bookmarkBonus) * (1 + wordCountFactor)) * timeDecayFactor;
        return Math.min(99, score * 0.9);
    };

    const getScoreClass = (score) => {
        if (score >= CONFIG.colorThresholds.medium) return 'quality-score-high';
        if (score >= CONFIG.colorThresholds.low) return 'quality-score-medium';
        return 'quality-score-low';
    };

    const addScoresToWorks = () => {
        $('ol.work.index > li').each(function () {
            const $work = $(this);
            const $stats = $work.find('dl.stats');

            try {
                const stats = {
                    hits: parseInt($stats.find('dd.hits').text().replace(/,/g, '')) || 0,
                    kudos: parseInt($stats.find('dd.kudos a').text().replace(/,/g, '')) || 0,
                    chapters: parseInt($stats.find('dd.chapters a').text().split('/')[0]) || 1,
                    comments: parseInt($stats.find('dd.comments a').text().replace(/,/g, '')) || 0,
                    bookmarks: parseInt($stats.find('dd.bookmarks a').text().replace(/,/g, '')) || 0,
                    wordCount: parseInt($stats.find('dd.words').text().replace(/,/g, '')) || 0,
                    publishDate: new Date($work.find('p.datetime').text())
                };

                const qualityScore = calculateQualityScore(stats);
                $work.attr('data-quality-score', qualityScore);

                if (CONFIG.options.showScores) {
                    const scoreDisplay = qualityScore.toFixed(1);
                    const $scoreElement = $('<dd>')
                        .addClass('quality-score')
                        .addClass(getScoreClass(qualityScore))
                        .text(`Score: ${scoreDisplay}`);
                    $stats.addClass('work-stats').append($scoreElement);
                }

                if (CONFIG.options.hideWorks && qualityScore < CONFIG.options.hideThreshold) {
                    $work.hide();
                }

            } catch (error) {
                console.error(`Error processing work stats: ${error.message}`);
            }
        });

        if (CONFIG.options.autoSort) {
            sortWorksByScore();
        }
    };

    const sortWorksByScore = () => {
        const $workList = $('ol.work.index');
        const $works = $workList.children('li').get();

        $works.sort((a, b) => {
            const scoreA = parseFloat($(a).attr('data-quality-score')) || 0;
            const scoreB = parseFloat($(b).attr('data-quality-score')) || 0;
            return scoreB - scoreA;
        });

        $workList.append($works);
    };

    const addQualityScoreMenu = () => {
        const $headerMenu = $('ul.primary.navigation.actions');
        if ($headerMenu.length === 0) {
            console.error('Header menu not found, skipping menu addition');
            return;
        }

        const $scoreMenu = $('<li class="dropdown">').html('<a href="#">Quality Score</a>');
        $headerMenu.find('li.search').before($scoreMenu);

        const $dropMenu = $('<ul class="menu dropdown-menu">');
        $scoreMenu.append($dropMenu);

        const addMenuItem = (text, clickHandler) => {
            const $menuItem = $('<li>').html(`<a href="#">${text}</a>`);
            $menuItem.on('click', (e) => {
                e.preventDefault();
                clickHandler();
            });
            $dropMenu.append($menuItem);
        };

        addMenuItem(`Auto-sort: ${CONFIG.options.autoSort ? 'ON' : 'OFF'}`, () => {
            CONFIG.options.autoSort = !CONFIG.options.autoSort;
            GM_setValue('autoSort', CONFIG.options.autoSort);
            location.reload();
        });

        addMenuItem(`Show Scores: ${CONFIG.options.showScores ? 'ON' : 'OFF'}`, () => {
            CONFIG.options.showScores = !CONFIG.options.showScores;
            GM_setValue('showScores', CONFIG.options.showScores);
            location.reload();
        });

        addMenuItem(`Hide Low Quality: ${CONFIG.options.hideWorks ? 'ON' : 'OFF'}`, () => {
            CONFIG.options.hideWorks = !CONFIG.options.hideWorks;
            GM_setValue('hideWorks', CONFIG.options.hideWorks);
            location.reload();
        });

        addMenuItem('Set Hide Threshold', () => {
            const newThreshold = prompt('Enter new hide threshold (0-100):', CONFIG.options.hideThreshold);
            if (newThreshold !== null && !isNaN(newThreshold)) {
                CONFIG.options.hideThreshold = Math.min(100, Math.max(0, parseInt(newThreshold)));
                GM_setValue('hideThreshold', CONFIG.options.hideThreshold);
                location.reload();
            }
        });

        addMenuItem('Recalculate Scores', () => {
            addScoresToWorks();
        });

        addMenuItem('Sort by Score (High to Low)', () => sortWorksByScore(false));
        addMenuItem('Sort by Score (Low to High)', () => sortWorksByScore(true));
    };

    // Main execution
    $(document).ready(() => {
        addQualityScoreMenu();
        addScoresToWorks();
    });

})(jQuery);