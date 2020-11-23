let sql = null, database = null, info = {};
const loadSQL = async (file) => {
	try {
		if (!sql) {
			// sql.js の動作に必要な wasm を CDN から読み込む
			sql = await initSqlJs({
				locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.4.0/dist/${file}`
			});
		}

		let bytes = null;
		try {
			const array = await file.arrayBuffer();
			bytes = new Uint8Array(array);
		}
		catch(e) {
			document.getElementById("error").innerHTML
				= "ファイルを読み込めませんでした。<br>ファイルサイズが大きすぎる可能性があります。<br><br>"
				+ e.toString();
			return 1;
		}
		if (database) database.close();
		database = new sql.Database(bytes);
		info = getInfo(database);
		if (Object.keys(info).length === 0) return 1;

		// 範囲選択をするスライドバーの範囲更新
		document.getElementById('slider').noUiSlider.updateOptions({
			range: { 'min': info.startTime, 'max': info.stopTime },
			start: [ info.startTime, info.stopTime ]
		}, false);

		// 描画
		draw(info.startTime, info.stopTime);

		return 0;
	}
	catch(e) {
		document.getElementById("error").innerHTML
			= "不明なエラーが発生しました。<br><br>"
			+ e.toString();
		return 1;
	}
};

const getInfo = (database) => {
	// テーブルが存在しているかを確認
	try {
		const tableCount = database.exec(
			"SELECT count(*) FROM sqlite_master WHERE name IN('timestamp', 'trajectory', 'people')"
		);
		if (3 !== tableCount[0].values[0][0]) {
			document.getElementById("error").innerHTML
				= "このsqlファイルにはpeopleテーブル、timestampテーブル、trajectoryテーブルのいずれかが存在していません。";
			return {};
		}
	}
	catch(e) {
		document.getElementById("error").innerHTML
			= "このファイルはsqlite3ファイルではない可能性があります。<br><br>"
			+ e.toString();
		return {};
	}

	/* ここは歪み補正と射影変換がされていない軌跡を表示するときにコメントを外す
	// 処理速度向上のため、軌跡のテーブルを作成する
	database.exec("DROP TABLE IF EXISTS trajectory");
	const joint_avg = axis => ("((" +
		[...Array(25).keys()].map(num=>`(joint${num}${axis}*joint${num}confidence)`).join("+") + ")/(" +
		[...Array(25).keys()].map(num=>`joint${num}confidence`).join("+") +
	"))");
	const statement = database.exec(
		"CREATE TABLE trajectory AS SELECT frame, people, " +
		`${joint_avg("x")} AS x, ${joint_avg("y")} AS y ` +
		"FROM people_with_tracking ORDER BY people ASC, frame ASC"
	);
	*/

	// 動画の始まりと終わりの時間を取得
	const timeRangeTable = database.exec("SELECT min(timestamp), max(timestamp) FROM timestamp");
	const startTime = timeRangeTable[0].values[0][0];
	const stopTime = timeRangeTable[0].values[0][1];

	// 各フレームの人口密度を取得してcanvasに描画
	const maxPeople = database.exec(
		"SELECT max(people_count) FROM (SELECT count(people) AS people_count FROM people GROUP BY frame);"
	)[0].values[0][0];
	const populationDensityStatement = database.prepare(
		"SELECT people.frame, timestamp, count(people) FROM people INNER JOIN timestamp ON people.frame=timestamp.frame GROUP BY people.frame;"
	);
	const rangeCanvas = document.getElementById("range-canvas");
	const rangeContext = rangeCanvas.getContext('2d');
	rangeContext.globalCompositeOperation = "source-over";
	rangeContext.clearRect(0, 0, rangeCanvas.width, rangeCanvas.height);
	rangeContext.strokeStyle = "#303030C0";
	let people = 0, frame = -1, x = 0, y = 0, y_bottom = rangeCanvas.height - 1;
	rangeContext.beginPath();
	rangeContext.moveTo(0, y_bottom);
	while (populationDensityStatement.step()) {
		const value = populationDensityStatement.get();
		if (frame++ !== value[0]) {
			rangeContext.lineTo(x, y_bottom);
			x = (rangeCanvas.width - 1) * (value[1] - startTime) / (stopTime - startTime);
			rangeContext.lineTo(x, y_bottom);
			y = y_bottom - (y_bottom - 1) * (value[2] / maxPeople);
			rangeContext.lineTo(x, y);
			frame = value[0];
		}
		else if (value[2] === people) continue;
		else {
			x = (rangeCanvas.width - 1) * (value[1] - startTime) / (stopTime - startTime);
			rangeContext.lineTo(x, y);
			y = y_bottom - (y_bottom - 1) * (value[2] / maxPeople);
			rangeContext.lineTo(x, y);
		}
	}
	rangeContext.lineTo(rangeCanvas.width - 1, rangeCanvas.height - 1);
	rangeContext.closePath();
	rangeContext.stroke();

	return {
		"startTime": startTime,
		"stopTime": stopTime
	};
};

const draw = (startTime, stopTime) => {
	if (database === null) return;

	// canvasのelementを取得
	const canvas = document.getElementById("plot-canvas");
	const context = canvas.getContext('2d');

	// 背景を黒に、線の太さは3pxに設定する
	context.globalCompositeOperation = "source-over";
	context.fillStyle = "#000000FF";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.lineWidth = 3;
	context.lineJoin = "bevel";
	context.globalCompositeOperation = "lighter";

	// 描画する時間の範囲からフレームの範囲を取得する
	const frameRangeStatement = database.prepare(
		"SELECT min(frame), max(frame) FROM timestamp WHERE $start <= timestamp AND timestamp <= $stop"
	);
	frameRange = frameRangeStatement.get({"$start": startTime, "$stop": stopTime});
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

	// ローディングのぐるぐるを消す
	document.getElementById("draw-loading").style.visibility = "hidden";
};

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

const timeFormatter = (time) => {
	sec = (Math.floor(time / 1000.0) - ((Math.floor(time / 60000.0) * 60.0)));
	min = (Math.floor(time / 60000.0) - ((Math.floor(time / 3600000.0) * 60.0)));
	hour = Math.floor(time / 3600000.0);
	return `${("00"+hour).slice(-2)}:${("00"+min).slice(-2)}:${("00"+sec).slice(-2)}`;
};