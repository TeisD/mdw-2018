const fs = require('fs');
const path = require('path');
const http = require('http');
const querystring = require('querystring');
const TextSearch = require('rx-text-search');
const Page = require('../shared/modules/Page');
const moment = require('moment');
const _ = require('lodash');
const util = require('util');
const {
	exec
} = require('child_process');
const mysql = require('mysql');

const PORT = 3000;
const KEY = fs.readFileSync(path.join(__dirname, '../shared/config/keys/api-key'), 'utf8').trim();
const DATA_DIR = path.join(__dirname, '../../mdw-2018-data/');

const INSTAGRAM_SEARCH = path.join(__dirname, 'apps/instagram-search.sh');
const INSTAGRAM_SEARCH_PATH = path.join(DATA_DIR, 'instagram');

const DB = 'mdw_2018';
const TWITTER_TABLE = 'twitter';
const FUORI_TABLE = 'fuorisalone';
const DB_AUTH = require('../shared/config/keys/mysql.json');

const pages = Page.loadFolder(path.join(DATA_DIR, 'pages'));

const db = mysql.createPool({
	connectionLimit: 100,
	host: DB_AUTH.host,
	user: DB_AUTH.user,
	password: DB_AUTH.password,
	database: DB,
	charset: 'utf8mb4',
	//debug: true
});

console.log('Initializing...');

start();

function start() {
	console.log('[OK] Server ready');
	const server = http.createServer((request, response) => {
		request.on('error', (err) => {
			console.error('[ERROR] ' + err);
			response.statusCode = 400;
			response.end();
		});

		response.on('error', (err) => {
			console.error('[ERROR] ' + err);
		});

		console.log('Client connected');

		if (request.method === 'POST') {
			let body = '';

			request.on('data', (chunk) => {
				body += chunk;
			}).on('end', () => {
				body = querystring.parse(body);

				let data,
					r;

				if (body.key.trim() !== KEY) {
					r = Promise.reject('401')
				} else {
					switch (request.url.split('/')[1]) {
						case 'instagram':
							console.log('-> /instagram');
							try {
								r = instagram(body.page);
							} catch (e) {
								r = Promise.reject(e);
							}
							break;
						case 'image':
							console.log('-> image');
							try {
								r = image(body.image).then((data) => {
									response.writeHead(200, {
										'Content-Type': 'image/jpg'
									});
									response.end(data, 'binary');
								});
							} catch (e) {
								r = Promise.reject(e);
							}
							break;
						case 'twitter':
							console.log('-> /twitter');
							try {
								r = twitter(body.page);
							} catch (e) {
								r = Promise.reject(e);
							}
							break;
						case 'salone':
							console.log('-> /salone');
							try {
								r = salone(body.page);
							} catch (e) {
								r = Promise.reject(e);
							}
							break;
						case 'fuorisalone':
							console.log('-> /fuorisalone');
							try {
								r = fuorisalone(body.page);
							} catch (e) {
								r = Promise.reject(e);
							}
							break;
						default:
							r = Promise.reject('404');
							break;
					}
				}

				if (typeof r === 'undefined') r = Promise.reject("Routine returned undefined");

				r.then((data) => {
						if (response.finished) return;
						response.statusCode = 200;
						response.setHeader('Content-Type', 'application/json');
						response.end(JSON.stringify(data));
						console.log("[OK] Sent response to client");
					})
					.catch((err) => {
						console.error('[ERROR] ' + err);
						if (err == '401') {
							response.statusCode = 401;
							response.end();
						} else if (err == '404') {
							response.statusCode = 404;
							response.end();
						} else {
							response.statusCode = 400;
							response.end(JSON.stringify(err));
						}
					});
			});
		} else {
			response.statusCode = 404;
			response.end();
		}

	}).listen(PORT);

	server.on('error', function (err) {
		console.error('[ERROR] ' + err);
	});
}

function instagram(page) {
	var p = Page.find(pages, page);

	if (typeof p === 'undefined') return Promise.reject('Page "' + page + '" not found');

	var queries = []

	p.keywords.instagram.forEach((ig) => {
		queries.push(new Promise((resolve, reject) => {
			let query = ig.keywords.map((k) => {
				return `'` + k.replace(/\s/g, '.*') + `'`;
			}).join(' ');

			let count = (ig.hasOwnProperty('all') && ig.all) ? 30 : 1;

			exec(`bash '${INSTAGRAM_SEARCH}' '${INSTAGRAM_SEARCH_PATH}' ${count} ${query}`, (err, stdout, stderr) => {
				let res = {
					keywords: ig.keywords,
					images: stdout.split('\n').filter((i) => {
						return (i && i.length > 1);
					}).map((i) => {
						i = i.split('/');
						i = i.slice(i.length - 2).join('/');
						i = i.substr(0, i.lastIndexOf('_UTC') + 4) + '.jpg';
						return i;
					}),
					captions: ig.captions
				}
				if (ig.hasOwnProperty('always') && ig.always) res.always = true;
				resolve(res);
			})
		}));
	});

	return Promise.all(queries).then((data) => {
		// remove the empty results
		let response = data.filter((keyword) => {
			return (keyword.images.length > 0 || keyword.hasOwnProperty('always'));
		});

		// sort the "all" results internally
		response.forEach((keyword) => {
			if (keyword.hasOwnProperty('all') && keyword.all) {
				keyword.images.sort((a, b) => sort);
			}
		});

		// sort the results (put the "always" result on top)
		response.sort((a, b) => {
			if (a.hasOwnProperty('always') && a.always) return -1;
			if (b.hasOwnProperty('always') && b.always) return 1;
			return sort(a.images[0], b.images[0]);
		});

		return Promise.resolve(response);
	});

	/**
	 * Sort filename by date
	 */
	function sort(a, b) {
		a = a.substring(a.lastIndexOf('/') + 1, a.lastIndexOf('_UTC'));
		b = b.substring(b.lastIndexOf('/') + 1, b.lastIndexOf('_UTC'));
		a = moment(a, 'YYYY-MM-DD_HH-mm-ss');
		b = moment(b, 'YYYY-MM-DD_HH-mm-ss');
		return b - a;
	}
}

function image(image) {
	if (typeof image === 'undefined') return Promise.reject(404);

	return new Promise((resolve, reject) => {
		fs.readFile(path.join(DATA_DIR, 'instagram', image), (err, data) => {
			if (err) {
				if (err.code === 'ENOENT') return reject('404');
				return reject(err);
			}
			resolve(data);
		});
	});
}


function twitter(page) {
	var p = Page.find(pages, page);

	if (typeof p === 'undefined') return Promise.reject('Page "' + page + '" not found');

	let queries = p.keywords.twitter.map((keyword) => {
		return twitterQuery(keyword);
	})

	return Promise.all(queries);

	/**
	 * Execute query as a promise
	 */
	function twitterQuery(keyword) {
		return new Promise((resolve, reject) => {
			db.query(`SELECT COUNT(*) FROM ${TWITTER_TABLE} WHERE type = 'hashtag' AND text LIKE '%${keyword}%'`, [], function (err, count) {
				if (err) return reject(err);
				// make an additional query if the word is interesting
				if (count[0]['COUNT(*)'] > 0 && keyword.length > 7) {
					db.query(`SELECT DISTINCT text FROM ${TWITTER_TABLE} WHERE type = 'hashtag' AND text LIKE '%${keyword}%' ORDER BY created_at LIMIT 1`, [], function (err, text) {
						if (err) return reject(err);
						resolve({
							word: keyword,
							count: count[0]['COUNT(*)'],
							text: parseTweet(text[0].text)
						});
					});
				} else {
					resolve({
						word: keyword,
						count: count[0]['COUNT(*)'],
					});
				}
			});
		})
	}

	/**
	 * Clean a tweet and return the main body only
	 */
	function parseTweet(text) {
		// remove links
		text = text.replace(/http\S*/g, '');
		// remove subsequent hashtags
		text = text.replace(/#\w*\s*(#\w*\s*)+/g, '');
		// remove subsequent mentions
		text = text.replace(/@\w*\s*(@\w*\s*)+/g, '');
		// remove RT
		text = text.replace(/RT @\w*:/g, '');
		// remove via
		text = text.replace(/via @\w*/g, '');

		return text.trim();
	}
}


function salone(page) {
	return new Promise((resolve, reject) => {
		fs.readFile(path.join(DATA_DIR, 'projects', page, 'vis.json'), (err, data) => {
			if (err) {
				if (err.code === 'ENOENT') return reject(404)
				else return reject(err);
			}
			if (typeof data === "undefined") return reject('404');
			let response = '';

			JSON.parse(data).forEach(s => {
				if (s.caption) {
					response += s.caption.charAt(0).toUpperCase() + s.caption.slice(1) + '. ';
				}
			});

			resolve(response.trim());
		});
	});
}

function fuorisalone(page) {
	var p = Page.find(pages, page);

	if (typeof p === 'undefined') return Promise.reject('Page "' + page + '" not found');

	let today = moment().format('dddd').toLowerCase();
	console.log(today);

	let queries = p.keywords.time.map((keyword) => {
		let k = keyword.keywords.replace(/,/g, '%');
		return saloneQuery(k);
	})

	return Promise.all(queries).then((data) => {
		data = data.filter(n => n);
		if(data.length > 0) return Promise.resolve(data);
		// if no keywords found, make an additional query based on the year
		return Promise.all(p.keywords.time.map((keyword) => {
			return saloneQuery(keyword.year);
		}));
	}).then((data) => {
		data = data.filter(n => n);
		return Promise.resolve([_.sample(data)]);
	});

	/**
	 * Execute query as a promise
	 */
	function saloneQuery(keyword) {
		return new Promise((resolve, reject) => {
			db.query(`SELECT * FROM ${FUORI_TABLE} WHERE ${today} IS NOT NULL AND description IS NOT NULL AND description != '' AND extended LIKE '%${keyword}%'`, [], function (err, result) {
				if (err) return reject(err);
				if (result.length == 0) return resolve();
				resolve({
					title: result[0].title,
					organiser: result[0].organiser,
					address: result[0].address.replace(/\t.*/, ''),
					description: result[0].description,
					today: result[0][today]
				});
			});
		})
	}
}
