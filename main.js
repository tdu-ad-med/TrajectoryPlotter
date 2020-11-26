const UIControll = class {
	constructor() {
		document.addEventListener("DOMContentLoaded", async () => {
			try { await this.init(); }
			catch(e) {
				this.error("不明なエラーが発生しました。", e);
				return;
			}	
		});
	}
	async init() {
		// UIの操作に必要なDOMの要素を取得する
		this.ui_elements = {
			plot: document.getElementById("plot"),
			plot_canvas: document.getElementById("plot_canvas"),
			loading: Array.from(document.getElementsByClassName("loading")),
			range_canvas: document.getElementById("range_canvas"),
			range_mask: document.getElementById("range_mask"),
			slider: document.getElementById("slider"),
			range_text: document.getElementById("range_text"),
			correction_param: document.getElementById("correction_param"),
			transform_param: document.getElementById("transform_param"),
			preset_param: Array.from(document.getElementsByClassName("preset_param")),
			upload: document.getElementById("upload"),
			upload_box: document.getElementById("upload_box"),
			upload_box_main: document.getElementById("upload_box_main"),
			file_selector: document.getElementById("file_selector"),
			error: Array.from(document.getElementsByClassName("error")),
		};

		this.error = (message, e) => {
			this.ui_elements.error.forEach(elem => {
				elem.innerHTML = `${message}<br><br>` + e.toString();
			});
		}

		// 設定を行うDOMの要素を取得する
		this.param_elements = {
			input_width: document.getElementById("input_width"),
			input_height: document.getElementById("input_height"),
			output_width: document.getElementById("output_width"),
			output_height: document.getElementById("output_height"),
			background: document.getElementById("background"),
			line_transparent: document.getElementById("line_transparent"),
			line_weight: document.getElementById("line_weight"),
			enable_correction: document.getElementById("enable_correction"),
			calib_width: document.getElementById("calib_width"),
			calib_height: document.getElementById("calib_height"),
			fx: document.getElementById("fx"),
			fy: document.getElementById("fy"),
			cx: document.getElementById("cx"),
			cy: document.getElementById("cy"),
			k1: document.getElementById("k1"),
			k2: document.getElementById("k2"),
			k3: document.getElementById("k3"),
			k4: document.getElementById("k4"),
			enable_transform: document.getElementById("enable_transform"),
			p1_x: document.getElementById("p1_x"),
			p1_y: document.getElementById("p1_y"),
			p2_x: document.getElementById("p2_x"),
			p2_y: document.getElementById("p2_y"),
			p3_x: document.getElementById("p3_x"),
			p3_y: document.getElementById("p3_y"),
			p4_x: document.getElementById("p4_x"),
			p4_y: document.getElementById("p4_y"),
			p1_p2_distance: document.getElementById("p1_p2_distance"),
			p2_p3_distance: document.getElementById("p2_p3_distance"),
			scale: document.getElementById("scale"),
			offset_x: document.getElementById("offset_x"),
			offset_y: document.getElementById("offset_y"),
			draw_border: document.getElementById("draw_border"),
			only_preview: document.getElementById("only_preview"),
			apply_param: document.getElementById("apply_param"),
		};

		// sql.js の動作に必要な wasm を CDN から読み込む
		this.sql = await initSqlJs({
			locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.4.0/dist/${file}`
		});

		// 軌跡の描画を行うクラスのインスタンスを生成する
		this.graph = new Graph(this.ui_elements.plot_canvas, this.ui_elements.range_canvas, this.sql, this.error);

		// イベントリスナを登録する
		this.ui_elements.file_selector.addEventListener("change", e => {
			this.open_file(e.target.files);
		});
		document.addEventListener("dragover", e => {
			e.preventDefault();
			this.ui_elements.upload_box.style.background = "#555";
		});
		document.addEventListener("dragleave", e => {
			this.ui_elements.upload_box.style.background = "#F2F2F2";
		});
		document.addEventListener("drop", e => {
			e.preventDefault();
			this.ui_elements.upload_box.style.background = "#F2F2F2";
			this.open_file(e.dataTransfer.files);
		});

		// 範囲選択をするスライドバーの設置
		noUiSlider.create(this.ui_elements.slider, { range: { 'min': 0, 'max': 1 }, start: [ 0, 1 ], step: 1, connect: true });

		// スライドバーが更新されたとき(変更中)
		this.ui_elements.slider.noUiSlider.on('update.one', (values, handle) => {
			this.ui_elements.range_text.innerHTML =
				`開始時間 : ${timeFormatter(parseFloat(values[0]))}<br>` +
				`終了時間 : ${timeFormatter(parseFloat(values[1]))}`;
			this.ui_elements.range_mask.style.left =
				(100.0 * parseFloat(values[0]) /
				(this.graph.sql_info.stopTime - this.graph.sql_info.startTime)) + "%";
			this.ui_elements.range_mask.style.width =
				(100.0 * (parseFloat(values[1]) - parseFloat(values[0])) /
				(this.graph.sql_info.stopTime - this.graph.sql_info.startTime)) + "%";
		});

		// スライドバーが更新されたとき(変更完了後)
		this.ui_elements.slider.noUiSlider.on('set.one', (values, handle) => {
			this.draw();
		});

		// チェックボックスが変更されたとき
		this.param_elements.enable_correction.addEventListener("change", (event) => {
			this.ui_elements.correction_param.style.display =
				this.param_elements.enable_correction.checked ? "block" : "none";
		});
		this.param_elements.enable_transform.addEventListener("change", (event) => {
			this.ui_elements.transform_param.style.display =
				this.param_elements.enable_transform.checked ? "block" : "none";
		});

		// プリセットを読み込んだとき
		this.ui_elements.preset_param.forEach(elem => { elem.addEventListener("click", e => {
			this.load_preset(elem.value);
		}); });
	}

	open_file(files) {
		if (files.length !== 1) return;

		// エラーメッセージをリセット
		this.ui_elements.error.forEach(elem => { elem.innerHTML = ""; });

		// ファイルを読み込んでいる間はぐるぐるを表示させる
		this.ui_elements.upload_box_main.style.visibility = "hidden";
		this.ui_elements.loading.forEach(elem => { elem.style.visibility = "visible"; });

		setTimeout(async () => {
			if (await this.graph.open_file(files[0]) === 0) {
				this.reflect_sql_info(this.graph.sql_info);
				this.ui_elements.upload.style.display = "none";
				this.ui_elements.plot.style.display = "block";
			}

			// スタイルを元に戻す
			this.ui_elements.upload_box_main.style.visibility = "visible";
			this.ui_elements.loading.forEach(elem => { elem.style.visibility = "hidden"; });
		}, 0);
	}
	draw() {}
	load_preset(name) {}
	reflect_sql_info(sql_info) {
		// 範囲選択をするスライドバーの範囲更新
		this.ui_elements.slider.noUiSlider.updateOptions({
			range: { 'min': sql_info.startTime, 'max': sql_info.stopTime },
			start: [ sql_info.startTime, sql_info.stopTime ]
		}, false);
	}
};

const uiControll = new UIControll();

/*

const openFile = (files) => {
	// ファイルを読み込んでいる間はぐるぐるを表示させる
	document.getElementById("error").innerHTML = "";
	document.getElementById("upload-box-main").style.visibility = "hidden";
	document.getElementById("upload-box-loading").style.visibility = "visible";
	document.getElementById("draw-loading").style.visibility = "visible";

	setTimeout(async () => {
		if (files.length === 1) {
			if (await loadSQL(files[0]) !== 1) {
				document.getElementById("upload").style.display = "none";
				document.getElementById("plot").style.display = "block";
			}
		}

		// スタイルを元に戻す
		document.getElementById("upload-box-main").style.visibility = "visible";
		document.getElementById("upload-box-loading").style.visibility = "hidden";
	}, 0);
};

document.addEventListener("DOMContentLoaded", () => {
	// ファイルを読み込むイベント
	document.getElementById("file-selector").addEventListener("change", e => {
		const files = e.target.files;
		openFile(files);
	}, false);
	document.addEventListener("dragover", e => {
		e.preventDefault();
		document.getElementById("upload-box").style.background = "#555";
	}, false);
	document.addEventListener("dragleave", e => {
		document.getElementById("upload-box").style.background = "#F2F2F2";
	}, false);
	document.addEventListener("drop", e => {
		e.preventDefault();
		document.getElementById("upload-box").style.background = "#F2F2F2";
		const files = e.dataTransfer.files;
		openFile(files);
	}, false);

	// 範囲選択をするスライドバーの設置
	const slider = document.getElementById('slider');
	const range_text = document.getElementById('range-text');
	const range_mask = document.getElementById('range-mask');
	noUiSlider.create(slider, {
		range: {
			'min': 0,
			'max': 1
		},
		start: [0, 1],
		step: 1,
		connect: true
	});

	// スライドバーが更新されたとき(変更中)
	slider.noUiSlider.on('update.one', (values, handle) => {
		range_text.innerHTML
			= `開始時間 : ${timeFormatter(parseFloat(values[0]))}<br>終了時間 : ${timeFormatter(parseFloat(values[1]))}`;
		range_mask.style.left
			= (100.0 * parseFloat(values[0]) / (info.stopTime - info.startTime)) + "%";
		range_mask.style.width
			= (100.0 * (parseFloat(values[1]) - parseFloat(values[0])) / (info.stopTime - info.startTime)) + "%";
	});

	// スライドバーが更新されたとき(変更完了後)
	slider.noUiSlider.on('set.one', (values, handle) => {
		// ローディングのぐるぐるを表示する
		document.getElementById("draw-loading").style.visibility = "visible";

		// 再描画
		setTimeout(() => {
			draw(parseInt(values[0]), parseInt(values[1]));
		}, 0);
	});

	// チェックボックスが変更されたとき
	document.getElementById("transform").addEventListener("change", (event) => {
		// ローディングのぐるぐるを表示する
		document.getElementById("draw-loading").style.visibility = "visible";

		// 再描画
		setTimeout(() => {
			draw(parseInt(slider.noUiSlider.get()[0]), parseInt(slider.noUiSlider.get()[1]));
		}, 0);
	}, false);
}, false);

*/