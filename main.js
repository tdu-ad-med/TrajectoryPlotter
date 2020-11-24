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