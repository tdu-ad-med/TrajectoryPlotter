const hsvToRgb = (h, s, v) => {
	let r = v * 255.0;
	let g = v * 255.0;
	let b = v * 255.0;
	if (s <= 0.0) return {"r": r, "g": g, "b": b};
	h *= 6.0;
	const i = Math.floor(h);
	const f = h - i;
	if      (i < 1.0) { g *= 1.0 - s * (1.0 - f); b *= 1.0 - s; }
	else if (i < 2.0) { r *= 1.0 - s * f; b *= 1.0 - s; }
	else if (i < 3.0) { r *= 1.0 - s; b *= 1.0 - s * (1.0 - f); }
	else if (i < 4.0) { r *= 1.0 - s; g *= 1.0 - s * f; }
	else if (i < 5.0) { r *= 1.0 - s * (1.0 - f); g *= 1.0 - s; }
	else if (i < 6.0) { g *= 1.0 - s; b *= 1.0 - s * f; }
	return {"r": r, "g": g, "b": b};
};

const getInfo = (database) => {
	// テーブルが存在しているかを確認
	try {
		const tableCount = database.exec(
			"SELECT count(*) FROM sqlite_master WHERE name IN('timestamp', 'trajectory')"
		);
		if (2 !== tableCount[0].values[0][0]) {
			alert("このsqlファイルにはtimestampテーブルもしくはtrajectoryテーブルが存在していません。");
			return {};
		}
	}
	catch(e) {
		alert("このファイルはsqlite3ファイルではない可能性があります。詳細なエラーを表示するにはコンソールを確認してください。");
		console.log(e);
		return {};
	}

	try {
		// 動画の始まりと終わりの時間を取得
		const timeRangeTable = database.exec("SELECT min(timestamp), max(timestamp) FROM timestamp");
		const startTime = timeRangeTable[0].values[0][0];
		const stopTime = timeRangeTable[0].values[0][1];

		// canvasのelementを取得
		const canvas = document.getElementById("canvas");

		return {
			"startTime": startTime,
			"stopTime": stopTime,
			"width": canvas.width,
			"height": canvas.height
		};
	}
	catch(e) {
		alert("不明なエラーが発生しました。詳細なエラーを表示するにはコンソールを確認してください。");
		console.log(e);
		return {};
	}
};

const draw = (database, info) => {
	if (Object.keys(info).length === 0) return;

	// canvasのelementを取得
	const canvas = document.getElementById("canvas");
	canvas.width = info.width;
	canvas.height = info.height;
	const context = canvas.getContext('2d');

	// 背景を黒に、線の太さは3pxに設定する
	context.fillStyle = "#000000FF";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.lineWidth = 3;
	context.lineJoin = "bevel";
	context.globalCompositeOperation = "lighter";

	// 描画する時間の範囲からフレームの範囲を取得する
	const frameRangeStatement = database.prepare(
		"SELECT min(frame), max(frame) FROM timestamp WHERE $start <= timestamp AND timestamp <= $stop"
	);
	frameRange = frameRangeStatement.get({"$start": info.startTime, "$stop": info.stopTime});
	const startFrame = frameRange[0];
	const stopFrame =  frameRange[1];

	// 描画するフレームの範囲内の全ての軌跡情報を取得する
	const statement = database.prepare(
		"SELECT * FROM trajectory WHERE $start <= frame AND frame <= $stop ORDER BY people ASC, frame ASC"
	);
	statement.bind({"$start": startFrame, "$stop": stopFrame});

	// 軌跡の取りうる範囲を取得
	const trajectoryRangeTable = database.exec("SELECT min(x), min(y), max(x), max(y) FROM trajectory");
	const trajectoryRangeArray = trajectoryRangeTable[0].values[0];
	const trajectoryRange = {
		"left"  : trajectoryRangeArray[0],
		"top"   : trajectoryRangeArray[1],
		"width" : trajectoryRangeArray[2] - trajectoryRangeArray[0],
		"height": trajectoryRangeArray[3] - trajectoryRangeArray[1]
	};

	// 取得した軌跡のデータ数だけループする
	let personID = -1;
	while (statement.step()) {
		// 次の座標を取得
		const value = statement.get();
		const position = {"x": value[2], "y": value[3]};

		// 画面のサイズに収まるように位置調整

		// 軌跡の範囲のアスペクト比と画面のアスペクト比を求める
		const trajectoryAspect = trajectoryRange.width / trajectoryRange.height;
		const canvasAspect = canvas.width / canvas.height;

		// 画面のサイズより軌跡の範囲のほうが横長の場合
		if (trajectoryAspect > canvasAspect) {
			// 横座標が0.0から1.0の間になるように拡大縮小
			position.x = (position.x - trajectoryRange.left) / trajectoryRange.width;
			position.y = (position.y - trajectoryRange.top) / trajectoryRange.width;

			// 下に隙間ができるので、上下に均等に隙間ができるようにずらす
			const bottom_gap = (1.0 / canvasAspect) - (1.0 / trajectoryAspect);
			position.y += bottom_gap * 0.5;

			// 横座標が0.0からcanvas.widthの間になるように拡大縮小
			position.x *= canvas.width;
			position.y *= canvas.width;
		}
		else {
			// 縦座標が0.0から1.0の間になるように拡大縮小
			position.x = (position.x - trajectoryRange.left) / trajectoryRange.height;
			position.y = (position.y - trajectoryRange.top) / trajectoryRange.height;

			// 右に隙間ができるので、左右に均等に隙間ができるようにずらす
			const right_gap = canvasAspect - trajectoryAspect;
			position.x += right_gap * 0.5;

			// 縦座標が0.0からcanvas.heightの間になるように拡大縮小
			position.x *= canvas.height;
			position.y *= canvas.height;
		}
		

		// 人のIDが変わった場合
		if (personID !== value[1]) {
			// 前の人の軌跡の描画を終了する
			if (personID >= 0) context.stroke();

			// IDの記憶
			personID = value[1];

			// 色の指定
			let h = parseFloat(personID) * 0.111;
			h = h - Math.floor(h);
			const color = hsvToRgb(h, 0.5, 1.0);
			context.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, 0.1)`;

			// 新たに軌跡の描画を開始する
			context.beginPath();

			// 軌跡の始点を追加
			context.moveTo(position.x , position.y);

			continue;
		}

		// 軌跡の追加
		context.lineTo(position.x , position.y);
	}

	// 最後の人の軌跡の描画を終了する
	context.stroke();

	console.log("finish");
};

document.addEventListener("DOMContentLoaded", async () => {
	// sql.js の動作に必要な wasm を CDN から読み込む
	const sql = await initSqlJs({
		locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.4.0/dist/${file}`
	});

	// ファイルを読み込む
	let database = null;
	let info = {};
	const openFile = async (files) => {
		document.getElementById("state").innerHTML = "ファイルを開いています...";
		if (1 !== files.length) return;
		const file = files[0];
		let bytes = null;
		try {
			const array = await file.arrayBuffer();
			bytes = new Uint8Array(array);
		}
		catch(e) {
			alert("ファイルを読み込めませんでした。ファイルサイズが大きすぎる可能性があります。詳細なエラーを表示するにはコンソールを確認してください。");
			console.log(e);
			return;
		}
		if (database) database.close();
		database = new sql.Database(bytes);
		info = getInfo(database);
		if (Object.keys(info).length === 0) return;
		document.getElementById("state").innerHTML = "";

		document.getElementById("startTime").value = info.startTime;
		document.getElementById("stopTime").value = info.stopTime;
		document.getElementById("canvasWidth").value = info.width;
		document.getElementById("canvasHeight").value = info.height;

		document.getElementById('slider').noUiSlider.set([0, 1]);
	};
	document.getElementById("fileSelector").addEventListener("change", async e => {
		const files = e.target.files;
		await openFile(files);
	});
	document.addEventListener("dragover", e => { e.preventDefault(); });
	document.addEventListener("drop", async e => {
		e.preventDefault();
		const files = e.dataTransfer.files;
		await openFile(files);
	});
	document.getElementById("draw").addEventListener("click", async e => {
		if (!database) return;
		if (Object.keys(info).length === 0) return;
		document.getElementById("state").innerHTML = "軌跡を描画しています。";
		const customInfo = {
			"startTime": parseFloat(document.getElementById("startTime").value),
			"stopTime": parseFloat(document.getElementById("stopTime").value),
			"width": parseInt(document.getElementById("canvasWidth").value),
			"height": parseInt(document.getElementById("canvasHeight").value)
		};
		// drawは重たいので、その前にDOMを更新するためにdrawをsetTimeoutでキューの後ろにもっていく
		setTimeout(() => {
			draw(database, customInfo);
			document.getElementById("state").innerHTML = "";
		}, 0);
	});
	const slider = document.getElementById('slider');
	noUiSlider.create(slider, {
		start: [0, 0],
		range: {
			'min': 0,
			'max': 1
		},
		connect: true
	}).on('update', (values, handle) => {
		if (Object.keys(info).length === 0) return;
		document.getElementById("startTime").value = info.startTime + values[0] * info.stopTime;
		document.getElementById("stopTime").value = info.startTime + values[1] * info.stopTime;

		if(document.getElementById("check").checked) {
			document.getElementById("state").innerHTML = "軌跡を描画しています。";
			const customInfo = {
				"startTime": parseFloat(document.getElementById("startTime").value),
				"stopTime": parseFloat(document.getElementById("stopTime").value),
				"width": parseInt(document.getElementById("canvasWidth").value),
				"height": parseInt(document.getElementById("canvasHeight").value)
			};
			// drawは重たいので、その前にDOMを更新するためにdrawをsetTimeoutでキューの後ろにもっていく
			setTimeout(() => {
				draw(database, customInfo);
				document.getElementById("state").innerHTML = "";
			}, 0);
		}
	});
});