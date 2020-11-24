/*

軌跡の描画には自作のWebGLラッパーライブラリである「HydrangeaJS」を使用しています。
	HydrangeaJS : https://github.com/wakewakame/HydrangeaJS

また、魚眼レンズの歪み補正と射影変換のプログラムはOpenCVを参考にコピペしたものです。
	魚眼レンズの歪み補正の引用元 : https://github.com/opencv/opencv/blob/4.5.0/modules/calib3d/src/fisheye.cpp#L321
	射影変換の引用元 : https://github.com/opencv/opencv/blob/4.5.0/modules/imgproc/src/imgwarp.cpp#L3276

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
	const p = getPerspectiveTransform(
		[[598 , 246],
		 [1047, 276],
		 [1077, 624],
		 [537 , 601]].map(src => undistortPoints(src, f, c, k, [input_scale, input_scale], output_scale)),
		rect_scale(2.334, 1.800, canvas.width, canvas.height, 0.3)
	);
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
		mat3 t = mat3(${p});
		pos = vec2(
			(pos.x * t[0][0] + pos.y * t[1][0] + t[2][0]) / (pos.x * t[0][2] + pos.y * t[1][2] + t[2][2]),
			(pos.x * t[0][1] + pos.y * t[1][1] + t[2][1]) / (pos.x * t[0][2] + pos.y * t[1][2] + t[2][2])
		);
		gl_Position = matrix * vec4(pos, 0.0, 1.0);
	}
`
		, shader.default_shader.fragment
	);
	if (document.getElementById("transform").checked) graphics.shader(shader);

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
			graphics.gshape.color(color.r, color.g, color.b, 0.1);

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

	// 基準線の描画
	graphics.gshape.color(1, 0, 0, 1);
	graphics.gshape.beginWeightShape(2.0, true);
	[[598 , 246],
	 [1047, 276],
	 [1077, 624],
	 [537 , 601]].forEach(dst => graphics.gshape.vertex(dst[0] , dst[1], 0));
	graphics.gshape.endWeightShape();
	graphics.shape(graphics.gshape);

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

const rect_scale = (x, y, width, height, zoom) => {
	const rate = (x / y) / (width / height);
	const scale = zoom * 0.5 * ((rate > 1.0) ? (width / x) : (height / y));
	const center_x = width / 2.0;
	const center_y = height / 2.0;
	x *= scale; y *= scale;
	return [
		[center_x - x, center_y - y],
		[center_x + x, center_y - y],
		[center_x + x, center_y + y],
		[center_x - x, center_y + y]
	];
};

/**
 * 連立一次方程式を解く関数 (部分ピボット選択付きガウスの消去法)
 * @param left 左辺式の係数をまとめた行列 (例: [[0, 1, 2], [3, 4, 5], [6, 7, 8]])
 * @param right 右辺値のベクトル (例: [[0, 1, 2]])
 * @return 処理に成功すると方程式の解が返り、失敗するとnullが返る
 * @note 参考にしたサイト : http://www-it.sci.waseda.ac.jp/CPR2/classx1/slides/Cpro2_13th.pdf
 */
const solve = (left, right) => {
	let answer = right.concat();
	const n = answer.length;

	// 前進消去
	for(let col = 0; col < n; col++) {
		// 部分ピボット選択 (割り算の分母を大きくして計算精度を向上するため)
		let pivot = col;
		for(let row = col + 1; row < n; row++) {
			if (Math.abs(left[row][col]) > Math.abs(left[pivot][col])) {
				pivot = row;
			}
		}

		// col行目とpivot行目を入れ替える
		for(let col2 = col; col2 < n; col2++) {
			[left[col][col2], left[pivot][col2]] = [left[pivot][col2], left[col][col2]];
		}
		[right[col], right[pivot]] = [right[pivot], right[col]];

		// 0割りを避ける
		if (0.0 === left[col][col]) return null;

		// 消去する
		for(let row = col + 1; row < n; row++) {
			const r = left[row][col] / left[col][col];
			for(let col2 = col; col2 < n; col2++) {
				left[row][col2] -= r * left[col][col2];
			}
			right[row] -= r * right[col];
		}
	}

	// 後進代入
	for(let row = n - 1; ; row--) {
		// 0割りを避ける
		if (0.0 === left[row][row]) return null;

		// 代入する
		let sum = 0.0;
		for(let col = row + 1; col < n; col++) {
			sum += left[row][col] * answer[col];
		}
		answer[row] = (right[row] - sum) / left[row][row];

		// 最後の行に来たらループを抜ける
		if (0 === row) break;
	}

	return answer;
};

/**
 * 2次元座標上の任意の4点を指定した4点へ移動させる行列を求める関数
 * @param src 二次元座標上の任意の4点 (例: [[0, 0], [0, 1], [1, 1], [1, 0]])
 * @param dst 移動先の4点 (例: [[0, 0], [0, 1], [1, 1], [1, 0]])
 * @return 処理に成功すると3x3行列が返り、失敗するとnullが返る
 * @note 参考にしたサイト : https://github.com/opencv/opencv/blob/4.5.0/modules/imgproc/src/imgwarp.cpp#L3276
 */
const getPerspectiveTransform = (src, dst) => {
	let left = Array.from(new Array(8)).map(() => (new Array(8)));
	let right = new Array(8);

	for(let i = 0; i < 4; i++) {
		left[i][0] = left[i+4][3] = src[i][0];
		left[i][1] = left[i+4][4] = src[i][1];
		left[i][2] = left[i+4][5] = 1;
		left[i][3] = left[i][4] = left[i][5] =
		left[i+4][0] = left[i+4][1] = left[i+4][2] = 0;
		left[i][6] = -src[i][0]*dst[i][0];
		left[i][7] = -src[i][1]*dst[i][0];
		left[i+4][6] = -src[i][0]*dst[i][1];
		left[i+4][7] = -src[i][1]*dst[i][1];
		right[i] = dst[i][0];
		right[i+4] = dst[i][1];
	}

	const answer = solve(left, right);

	if (null === answer) return null;

	return [
		answer[0], answer[3], answer[6],
		answer[1], answer[4], answer[7],
		answer[2], answer[5], 1.0
	].join(", ");
};

/**
 * 魚眼レンズの歪みを補正する
 * @param src 補正前の画像上の座標
 * @param f[x, y] カメラの内部パラメータ行列の焦点距離 (ピクセル単位)
 * @param c[x, y] カメラの内部パラメータ行列の主点 (ピクセル単位)
 * @param k[k1, k2, k3, k4] 半径方向の歪み係数 k1, k2, k3, k4
 * @param input_scale[x, y] 今回使用する画像の解像度 / カメラキャリブレーションで使用した画像の解像度
 * @param output_scale 出力する点の拡大率
 * @return 補正後の画像上の座標
 * @note 使用例
 *   const dst = undistortPoints([0.2, 0.3], [1222.0, 1214.0], [967.0, 569.0], [-0.088, 0.038, -0.060, 0.033], [1.0, 1.0], 0.5);
 */
const undistortPoints = (src, f, c, k, input_scale, output_scale) => {
	const f_ = [f[0] * input_scale[0], f[1] * input_scale[1]];
	const c_ = [c[0] * input_scale[0], c[1] * input_scale[1]];
	const pw = [(src[0] - c_[0]) / f_[0], (src[1] - c_[1]) / f_[1]];

	const theta_d = Math.min(Math.max(-Math.PI / 2., Math.sqrt(pw[0] * pw[0] + pw[1] * pw[1])), Math.PI / 2.);

	let converged = false;
	let theta = theta_d;

	let scale = 0.0;

	const EPS = 1e-7;
	if (Math.abs(theta_d) > EPS) {
		for (let i = 0; i < 10; i++) {
			const theta2 = theta * theta;
			const theta4 = theta2 * theta2;
			const theta6 = theta4 * theta2;
			const theta8 = theta6 * theta2;
			const k0_theta2 = k[0] * theta2;
			const k1_theta4 = k[1] * theta4;
			const k2_theta6 = k[2] * theta6;
			const k3_theta8 = k[3] * theta8;
			const theta_fix =
				(theta * (1 + k0_theta2 + k1_theta4 + k2_theta6 + k3_theta8) - theta_d) /
				(1 + 3 * k0_theta2 + 5 * k1_theta4 + 7 * k2_theta6 + 9 * k3_theta8);
			theta = theta - theta_fix;
			if (Math.abs(theta_fix) < EPS) {
				converged = true;
				break;
			}
		}
		scale = Math.tan(theta) / theta_d;
	}
	else { converged = true; }
	const theta_flipped = ((theta_d < 0 && theta > 0) || (theta_d > 0 && theta < 0));
	if (converged && !theta_flipped) {
		const pu = [
			(pw[0] * scale * f_[0] * output_scale) + c_[0],
			(pw[1] * scale * f_[1] * output_scale) + c_[1]
		];
		return pu;
	}
	else { return [-1000000.0, -1000000.0]; }
};