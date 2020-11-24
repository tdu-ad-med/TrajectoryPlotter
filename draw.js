/*

軌跡の描画には自作のWebGLラッパーライブラリである「HydrangeaJS」を使用しています。
HydrangeaJS : https://github.com/wakewakame/HydrangeaJS

*/

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

	// 軌跡の再計算を行う (歪み補正なし)
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

	// 動画の始まりと終わりの時間を取得
	const timeRangeTable = database.exec("SELECT min(timestamp), max(timestamp) FROM timestamp");
	const startTime = timeRangeTable[0].values[0][0];
	const stopTime = timeRangeTable[0].values[0][1];

	// 各フレームの人口密度を取得してcanvasに描画
	const maxPeople = database.exec(
		"SELECT max(people_count) FROM (SELECT count(people) AS people_count FROM people GROUP BY frame)"
	)[0].values[0][0];
	const populationDensityStatement = database.prepare(
		"SELECT people.frame, timestamp, count(people) FROM people INNER JOIN timestamp ON people.frame=timestamp.frame GROUP BY people.frame"
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
	const graphics = new HydrangeaJS.WebGL.Graphics(canvas);

	// 背景を黒に、線の太さは3pxに設定する
	graphics.fill(0, 0, 0);
	graphics.rect(0, 0, canvas.width, canvas.height);

	// 歪み補正用のシェーダを読み込み
	const f = [1222.78852772764, 1214.377234799321];
	const c = [967.8020317677116, 569.3667691760459];
	const k = [-0.08809225804249926, 0.03839093574614055, -0.060501971675431955, 0.033162385302275665];
	const input_scale = (1280.0 / 1920.0);
	const output_scale = 0.5;
	const shader = graphics.createShader();
	shader.loadShader(
`
	precision highp float;
	attribute vec3 position;
	attribute vec2 uv;
	attribute vec4 color;
	uniform mat4 matrix;
	varying vec2 v_uv;
	varying vec4 v_color;
	const float PI = 3.14159265359;
	const float EPS = 1e-4;

	vec2 undistortPoints(vec2 src, vec2 f, vec2 c, vec4 k, vec2 input_scale, float output_scale) {
		f *= input_scale; c *= input_scale;
		vec2 pw = (src - c) / f;

		float theta_d = min(max(-PI / 2., length(pw)), PI / 2.);

		bool converged = false;
		float theta = theta_d;

		float scale = 0.0;

		if (abs(theta_d) > EPS) {
			for (int i = 0; i < 10; i++) {
				float theta2 = theta * theta;
				float theta4 = theta2 * theta2;
				float theta6 = theta4 * theta2;
				float theta8 = theta6 * theta2;
				float k0_theta2 = k.x * theta2;
				float k1_theta4 = k.y * theta4;
				float k2_theta6 = k.z * theta6;
				float k3_theta8 = k.w * theta8;
				float theta_fix =
					(theta * (1. + k0_theta2 + k1_theta4 + k2_theta6 + k3_theta8) - theta_d) /
					(1. + 3. * k0_theta2 + 5. * k1_theta4 + 7. * k2_theta6 + 9. * k3_theta8);
				theta = theta - theta_fix;
				if (abs(theta_fix) < EPS) {
					converged = true;
					break;
				}
			}
			scale = tan(theta) / theta_d;
		}
		else { converged = true; }
		bool theta_flipped = ((theta_d < 0. && theta > 0.) || (theta_d > 0. && theta < 0.));
		if (converged && !theta_flipped) {
			vec2 pu = pw * scale * f * output_scale + c;
			return pu;
		}
		else { return vec2(-1000000.0, -1000000.0); }
	}

	void main(void) {
		v_uv = uv;
		v_color = color;
		vec2 pos = undistortPoints(
			position.xy,
			vec2(${f[0]}, ${f[1]}), vec2(${c[0]}, ${c[1]}),
			vec4(${k[0]}, ${k[1]}, ${k[2]}, ${k[3]}),
			vec2(${input_scale}), ${output_scale}
		);
		gl_Position = matrix * vec4(pos, 0.0, 1.0);
	}
`
		, shader.default_shader.fragment
	);
	graphics.shader(shader);

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

	// 取得した軌跡のデータ数だけループする
	let personID = -1;
	let drawn = false;
	while (statement.step()) {
		// 次の座標を取得
		const value = statement.get();
		const position = {"x": value[2], "y": value[3]};

		// 人のIDが変わった場合
		if (personID !== value[1]) {
			// 前の人の軌跡の描画を終了する
			if (personID >= 0) {
				graphics.gshape.endWeightShape();
				graphics.shape(graphics.gshape);
			}

			// IDの記憶
			personID = value[1];

			// 色の指定
			let h = parseFloat(personID) * 0.111;
			h = h - Math.floor(h);
			const color = hsvToRgb(h, 0.5, 1.0);
			graphics.gshape.color(color.r, color.g, color.b, 0.05);

			// 新たに軌跡の描画を開始する
			graphics.gshape.beginWeightShape(1.0);
			drawn = true;

			// 軌跡の始点を追加
			graphics.gshape.vertex(position.x , position.y, 0);

			continue;
		}

		// 軌跡の追加
		graphics.gshape.vertex(position.x , position.y, 0);
	}

	// 最後の人の軌跡の描画を終了する
	if (drawn) {
		graphics.gshape.endWeightShape();
		graphics.shape(graphics.gshape);
		graphics.render();
	}

	// ローディングのぐるぐるを消す
	document.getElementById("draw-loading").style.visibility = "hidden";
};

const hsvToRgb = (h, s, v) => {
	let r = v;
	let g = v;
	let b = v;
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