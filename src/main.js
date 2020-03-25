const Apify = require('apify');
const cheerio = require('cheerio');

const { log } = Apify.utils;
const sourceUrl = 'https://www.fhi.no/sv/smittsomme-sykdommer/corona/dags--og-ukerapporter/dags--og-ukerapporter-om-koronavirus/';
const LATEST = 'LATEST';

Apify.main(async () => {
    const requestQueue = await Apify.openRequestQueue();
    const kvStore = await Apify.openKeyValueStore('COVID-19-NORWAY');
    const dataset = await Apify.openDataset('COVID-19-NORWAY-HISTORY');

    await requestQueue.addRequest({ url: sourceUrl });
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        useApifyProxy: true,
        apifyProxyGroups: ['SHADER'],
        handlePageTimeoutSecs: 60 * 2,
        handlePageFunction: async ({ $ }) => {
            log.info('Page loaded.');
            const now = new Date();

            const latestPdfURL = "https://www.fhi.no" + $($('.fhi-list li a').get(0)).attr('href');

            // Parse PDF into HTML
            const { output } = await Apify.call('jancurn/pdf-to-html', {
                url: latestPdfURL
            });

            // Load with Cheerio
            const x$ = cheerio.load(output.body);
            const dataText = x$('#pf5').text().split('Antall varslede per 100 000')[1];
            const regions = dataText.match(/\D+/g).map(region => region.trim()).filter(region => region.length > 3)
            const infectedNumbers = dataText.replace(/,/g,'.').match(/[+-]?([0-9]*[.])?[0-9]+/g).map((number,i) => i%3 === 0 ? parseFloat(number) : null).filter(number=>number);

            const infectedByRegion = regions.map((region,index) => ({
                region: region,
                infectedCount: infectedNumbers[index]
            }))

            const infected = infectedNumbers.reduce((sum,val) => sum+=val,0);

            const data = {
                infected,
                deaths: parseInt(x$('html').text().match(/\d+ dødsfall/)[0].replace(' dødsfall',''),10),
                infectedByRegion,
                sourceUrl,
                lastUpdatedAtApify: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())).toISOString(),
                readMe: 'https://apify.com/tugkan/covid-no',
            };

            // Compare and save to history
            const latest = await kvStore.getValue(LATEST) || {};
            delete latest.lastUpdatedAtApify;
            const actual = Object.assign({}, data);
            delete actual.lastUpdatedAtApify;

            await Apify.pushData({...data});

            if (JSON.stringify(latest) !== JSON.stringify(actual)) {
                log.info('Data did change :( storing new to dataset.');
                await dataset.pushData(data);
            }

            await kvStore.setValue(LATEST, data);
            log.info('Data stored, finished.');
        },

        // This function is called if the page processing failed more than maxRequestRetries+1 times.
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed twice.`);
        },
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    console.log('Crawler finished.');
});
