const fs = require('fs');
const path = require('path');
const _ = require('lodash');

// hardcode the region of interest (based on average for all page)
const ROI = {
	x0: 20,
	y0: 20,
	x1: 820,
	y1: 575
}

const GRID_SIZE = 5;
const MAX_ITERATIONS = 100;

class Page {

	constructor(width, height, offset, scale, title, author, number, content, blocks, keywords, layout) {
		this.width = width;
		this.height = height;
		this.offset = offset;
		this.scale = scale;
		this.title = title;
		this.author = author;
		this.number = parseInt(number);
		this.content = content;
		this.blocks = blocks;
		this.keywords = keywords;
		this.layout = layout;
	}

	/*
	 * Create a grid on the page to use for dynamic layouts
	 * It will divide the page in a 50x50 grid, and mark the cell as free if it intersects < 20% with a content block
	 * The layout algorithm will randomly start from one of the corners of the page, to introduce some variation
	 */
	layoutGrid() {
		this.layout.computed = [];
		// pick a random start position
		var alg = LAYOUT_ALG[0];

		for (let x = alg.start.x, i = 0; alg.test.x(x, alg.end.x); x += GRID_SIZE * alg.direction.x, i++) {
			let row = [];
			for (let y = alg.start.y, j = 0; alg.test.y(y, alg.end.y); y += GRID_SIZE * alg.direction.y, j++) {
				// set the basic info
				let b = {
					row: i,
					col: j,
					x: x,
					y: y,
					size: GRID_SIZE,
					important: false
				}
				// check if it intersects any content block
				// addition for idb: map line structure to blocks
				this.blocks.forEach(b => {
					b.bbox.x1 = b.bbox.x0 + b.bbox.w;
					b.bbox.y1 = b.bbox.y0 + b.bbox.h;
				});

				let intersections = this.blocks.map((block) => {
					// set the important flag by exact measures
					if (
						block.bbox.x0 < b.x + b.size &&
						block.bbox.x1 > b.x &&
						block.bbox.y0 < b.y + b.size &&
						block.bbox.y1 > b.y &&
						parseInt(block.text) === this.number
					) b.important = true;
					// set the free flag a bit more loose
					return (
						block.bbox.x1 < b.x + 0.2*b.size ||
						block.bbox.x0 > b.x + 0.8*b.size ||
						block.bbox.y1 < b.y + 0.2*b.size ||
						block.bbox.y0 > b.y + 0.8*b.size
					);
				});
				b.free = (intersections.reduce((a, b) => a + b) < intersections.length) ? false : true
				// store
				row.push(b);
			}
			this.layout.computed.push(row);
		}
	}

	/**
	 * Return the layoutbox around the coordinates x, y
	 */
	getLayoutBox(x, y) {
		return _.flatten(this.layout.computed).find((b) => {
			return (
				x >= b.x &&
				x < b.x + b.size &&
				y >= b.y &&
				y < b.y + b.size
			);
		});
	}

	/**
	 * Return the layoutbox right to box
	 */
	getLayoutBoxRight(box) {
		if (typeof box === 'undefined') return;
		return this.getLayoutBox(box.x + 50, box.y);
	}

	/**
	 * Return the layoutbox right to box
	 */
	getLayoutBoxLeft(box) {
		if (typeof box === 'undefined') return;
		return this.getLayoutBox(box.x - 50, box.y);
	}

	/**
	 * Return the layoutbox right to box
	 */
	getLayoutBoxAbove(box) {
		if (typeof box === 'undefined') return;
		return this.getLayoutBox(box.x, box.y - 50);
	}

	/**
	 * Return the layoutbox right to box
	 */
	getLayoutBoxBelow(box) {
		if (typeof box === 'undefined') return;
		return this.getLayoutBox(box.x, box.y + 50);
	}

	/**
	 * Mark a box as free
	 */
	setBoxState(box, free) {
		if (typeof box === 'undefined') return;
		this.layout.computed[box.row][box.col].free = free;
	}

	/*
	 * Find whitespace areas on a page
	 * A whitespace area can contain one non-whitespace block
	 * A whitespace area has mimimum 5 blocks
	 * A whitespace area has maximum 16 blocks
	 * A whitespace area has maximum 5 grid-items per row or column
	 * @return an array of whitespace areas
	 */
	findWhitespaceAreas() {
		let iteration = 0,
				result = [],
				free = freeLayoutGridItems.call(this);

		let cases = [
			[10,10],
			[8,8],
			[6,6],
			[5,5]
		];

		for (let c of cases) {
			for(let i = 0; i < MAX_ITERATIONS; i++) {
				let item = free[Math.floor(Math.random() * free.length)];
				expandLayoutGridItem.call(this, item, c[0], c[1]);
				if(free.length < 5) break;
			}
			if(free.length < 5) break;
		}

		return result;

		/*
		 * Try to expand a layout grid item
		 * The expansion can contain one occupied box
		 * @param item The item to start from
		 * @param cols The number of columns to expand horizontally
		 * @param rows The number of rows to expand vertically
		 */
		function expandLayoutGridItem(item, cols, rows) {
			let e = [],
					i = [],
					top = +Infinity,
					left = +Infinity;

			for (let row = item.row; row < item.row + rows && row < this.layout.computed.length; row++) {
				for (let col = item.col; col < item.col + cols && col < this.layout.computed[0].length; col++) {
					let item = this.layout.computed[row][col];
					if(item.hasOwnProperty('important') && item.important) return
					i.push(item);
					if(item.x < left) left = item.x;
					if(item.y < top) top = item.y;
					if(item.free) e.push(item);
				}
			}

			if(e.length >= rows*cols - 1) {
				// mark all as occupied
				i.forEach((box) => {
					box.free = false;
				})
				// recalculate the free
				free = freeLayoutGridItems.call(this);
				// push the result
				result.push({
					x: left,
					y: top,
					width: rows * GRID_SIZE,
					height: cols * GRID_SIZE,
				});
			}
		}

		/*
		 * Find all layout grid items that are not occupied
		 * @return An array of [row, col] indexes of free layout grid items
		 */
		function freeLayoutGridItems() {
			let f = [];

			this.layout.computed.forEach((row) => {
				row.forEach((box) => {
					if(box.free) f.push(box);
				});
			})

			return f;
		}
	}

	/*
	 * Construct a new Page from a json file
	 * @param file The file to load
	 * @return The Page instance
	 */
	static load(file) {
		if (!fs.existsSync(file)) throw 'The file does not exist';

		var page = JSON.parse(fs.readFileSync(file));
		var width = page.width;
		var height = page.height;
		var offset = {
			x: page.hasOwnProperty('offsetX') ? page.offsetX : 0,
			y: page.hasOwnProperty('offsetY') ? page.offsetY : 0,
		}
		var scale = page.hasOwnProperty('scale') ? page.scale : 1;
		var title = page.title;
		var author = page.author;
		var number = page.number;
		var content = page.content;
		var blocks = page.blocks;
		var keywords = page.keywords;
		var layout = page.hasOwnProperty('layout') ? page.layout : {};

		return new Page(width, height, offset, scale, title, author, number, content, blocks, keywords, layout);
	}

	/*
	 * Load all the page json files in a certain directory and return an array of Page instances
	 * @param dir The directory to load
	 * @return An array of Page object
	 */
	static loadFolder(dir) {
		if (!fs.existsSync(dir)) throw 'The folder ' + dir + ' does not exist';

		var pages = [];

		fs.readdirSync(dir).forEach(file => {
			if(file.indexOf('.json') >= 0) {
  			pages.push(Page.load(path.join(dir, file)));
			}
		});

		return pages;
	}

	/*
	 * Find the Page with given pagenumber in an array of pages
	 * @param pages An array of pages
	 * @param pagenumber The pagenumber to find
	 */
	static find(pages, pagenumber) {
		for(let page of pages) {
			if(page.number == pagenumber) return page
		}
	}

}

// 4 different ways to start a grid
const LAYOUT_ALG = [
	// top left
	{
		start: {
			x: ROI.x0,
			y: ROI.y0,
		},
		end: {
			x: ROI.x1 - GRID_SIZE,
			y: ROI.y1 - GRID_SIZE,
		},
		direction: {
			x: +1,
			y: +1,
		},
		test: {
			x: function(i, end) { return i < end },
			y: function(i, end) { return i < end },
		}
	},
	// top right
	{
		start: {
			x: ROI.x1 - GRID_SIZE,
			y: ROI.y0,
		},
		end: {
			x: ROI.x0,
			y: ROI.y1 - GRID_SIZE,
		},
		direction: {
			x: -1,
			y: +1,
		},
		test: {
			x: function(i, end) { return i > end },
			y: function(i, end) { return i < end },
		}
	},
	// bottom left
	{
		start: {
			x: ROI.x0,
			y: ROI.y1 - GRID_SIZE,
		},
		end: {
			x: ROI.x1 - GRID_SIZE,
			y: ROI.y0,
		},
		direction: {
			x: +1,
			y: -1,
		},
		test: {
			x: function(i, end) { return i < end },
			y: function(i, end) { return i > end },
		}
	},
	// bottom right
	{
		start: {
			x: ROI.x1 - GRID_SIZE,
			y: ROI.y1 - GRID_SIZE,
		},
		end: {
			x: ROI.x0,
			y: ROI.y0,
		},
		direction: {
			x: -1,
			y: -1,
		},
		test: {
			x: function(i, end) { return i > end },
			y: function(i, end) { return i > end },
		}
	},
];

module.exports = Page;
