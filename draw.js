/*

軌跡の描画を行うプログラムです。
描画には自作のWebGLラッパーライブラリである「HydrangeaJS」を使用しています。
	HydrangeaJS : https://github.com/wakewakame/HydrangeaJS

*/



const Graph = class {
	constructor(plot_canvas, range_canvas, sql, error) {
		this.plot_canvas = plot_canvas;
		this.range_canvas = range_canvas;
		this.sql = sql;
		this.error = error;
		this.database = null;
		this.sql_info = {
			startTime : 0.0,
			stopTime  : 0.0,
			trajectoryRange: {
				left   : 0.0,
				top    : 0.0,
				width  : 1.0,
				height : 1.0
			},
		};
		this.range_context = this.range_canvas.getContext('2d');
		this.graphics = new HydrangeaJS.WebGL.Graphics(plot_canvas);
		const vertex_shader_code =
`precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 matrix;
varying vec2 v_uv;
varying vec4 v_color;

uniform int enable_correction;

uniform vec2 f;
uniform vec2 c;
uniform vec4 k;
uniform vec2 offset;
uniform vec2 calib_input_scale;
uniform mat3 t;

const float PI = 3.14159265359;
const float EPS = 1e-4;

vec2 undistortPoints(vec2 src, vec2 f, vec2 c, vec2 input_scale, float output_scale) {
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
	vec2 pos = position.xy;
	if (enable_correction == 1) {
		pos = undistortPoints(pos, f, c, calib_input_scale, 1.0);
	}
	pos = vec2(
		(pos.x * t[0][0] + pos.y * t[1][0] + t[2][0]) / (pos.x * t[0][2] + pos.y * t[1][2] + t[2][2]),
		(pos.x * t[0][1] + pos.y * t[1][1] + t[2][1]) / (pos.x * t[0][2] + pos.y * t[1][2] + t[2][2])
	);
	pos += offset;
	gl_Position = matrix * vec4(pos, 0.0, 1.0);
	v_color.a = (abs(gl_Position.x) > 1.5 || abs(gl_Position.y) > 1.5) ? 0.0 : 1.0;
}`
		const backimage_shader_code =
`precision highp float;
uniform sampler2D texture;
uniform float texture_transparent;
varying vec2 v_uv;
varying vec4 v_color;
void main(void){
	gl_FragColor = vec4(texture2D(texture, v_uv).rgb * texture_transparent, v_color.a);
}`;
		this.line_shader = this.graphics.createShader();
		this.line_shader.loadShader(this.line_shader.default_shader.vertex, this.line_shader.default_shader.fragment);
		this.backimage_shader = this.graphics.createShader();
		this.backimage_shader.loadShader(vertex_shader_code, backimage_shader_code);
		this.texture = this.graphics.createTexture(1, 1);
	}
	async open_file(file) {
		try {
			let bytes = null;
			try {
				const array = await file.arrayBuffer();
				bytes = new Uint8Array(array);
			}
			catch(e) {
				this.error("ファイルを読み込めませんでした。<br>ファイルサイズが大きすぎる可能性があります。", e);
				return 1;
			}
			if (this.database) this.database.close();
			this.database = new this.sql.Database(bytes);

			// テーブルが存在しているかを確認
			try {
				const tableCount = this.database.exec(
					"SELECT count(*) FROM sqlite_master WHERE name IN('timestamp', 'people', 'people_with_tracking')"
				);
				if (3 !== tableCount[0].values[0][0]) {
					this.error("このsqlファイルにはpeopleテーブル、timestampテーブル、people_with_trackingテーブルのいずれかが存在していません。", "");
					return 1;
				}
			}
			catch(e) {
				this.error("このファイルはsqlite3ファイルではない可能性があります。", e);
				return 1;
			}

			// 軌跡の再計算を行う (歪み補正なし)
			this.database.exec("DROP TABLE IF EXISTS trajectory");
			const joint_avg = axis => ("((" +
				[...Array(25).keys()].map(num=>`(joint${num}${axis}*joint${num}confidence)`).join("+") + ")/(" +
				[...Array(25).keys()].map(num=>`joint${num}confidence`).join("+") +
			"))");
			const statement = this.database.exec(
				"CREATE TABLE trajectory AS SELECT frame, people, " +
				`${joint_avg("x")} AS x, ${joint_avg("y")} AS y ` +
				"FROM people_with_tracking ORDER BY people ASC, frame ASC"
			);

			// 動画の始まりと終わりの時間を取得
			const timeRangeTable = this.database.exec("SELECT min(timestamp), max(timestamp) FROM timestamp");
			this.sql_info.startTime = timeRangeTable[0].values[0][0];
			this.sql_info.stopTime = timeRangeTable[0].values[0][1];

			// 骨格の取りうる範囲を取得
			const trajectoryRangeTable = this.database.exec(
				`SELECT min(x), min(y), max(x), max(y) FROM trajectory`
			);
			const trajectoryRangeArray = trajectoryRangeTable[0].values[0];
			this.sql_info.trajectoryRange = {
				left   : trajectoryRangeArray[0],
				top    : trajectoryRangeArray[1],
				width  : trajectoryRangeArray[2] - trajectoryRangeArray[0],
				height : trajectoryRangeArray[3] - trajectoryRangeArray[1]
			};

			// 各フレームの人口密度を取得してcanvasに描画
			const maxPeople = this.database.exec(
				"SELECT max(people_count) FROM (SELECT count(people) AS people_count FROM people GROUP BY frame)"
			)[0].values[0][0];
			const populationDensityStatement = this.database.prepare(
				"SELECT people.frame, timestamp, count(people) FROM people INNER JOIN timestamp ON people.frame=timestamp.frame GROUP BY people.frame"
			);
			
			this.range_context.globalCompositeOperation = "source-over";
			this.range_context.clearRect(0, 0, this.range_canvas.width, this.range_canvas.height);
			this.range_context.strokeStyle = "#303030C0";
			let people = 0, frame = -1, x = 0, y = 0, y_bottom = this.range_canvas.height - 1;
			this.range_context.beginPath();
			this.range_context.moveTo(0, y_bottom);
			while (populationDensityStatement.step()) {
				const value = populationDensityStatement.get();
				if (frame++ !== value[0]) {
					this.range_context.lineTo(x, y_bottom);
					x = (this.range_canvas.width - 1) * (value[1] - this.sql_info.startTime) / (this.sql_info.stopTime - this.sql_info.startTime);
					this.range_context.lineTo(x, y_bottom);
					y = y_bottom - (y_bottom - 1) * (value[2] / maxPeople);
					this.range_context.lineTo(x, y);
					frame = value[0];
				}
				else if (value[2] === people) continue;
				else {
					x = (this.range_canvas.width - 1) * (value[1] - this.sql_info.startTime) / (this.sql_info.stopTime - this.sql_info.startTime);
					this.range_context.lineTo(x, y);
					y = y_bottom - (y_bottom - 1) * (value[2] / maxPeople);
					this.range_context.lineTo(x, y);
				}
			}
			this.range_context.lineTo(this.range_canvas.width - 1, this.range_canvas.height - 1);
			this.range_context.closePath();
			this.range_context.stroke();

			return 0;
		}
		catch(e) {
			this.error("不明なエラーが発生しました。", e);
			return 1;
		}
	}
	draw(config) {
		// キャンバスのサイズを変更
		this.plot_canvas.width = config.output_width;
		this.plot_canvas.height = config.output_height;
		this.graphics.resize(this.plot_canvas.width, this.plot_canvas.height);

		// 背景を黒にする
		this.graphics.shader(this.graphics.shaders.normal);
		this.graphics.fill(0, 0, 0, 1);
		this.graphics.rect(0, 0, this.plot_canvas.width, this.plot_canvas.height);

		// 変換行列を計算
		let four_points = [
			[0.0               , 0.0                ],
			[config.input_width, 0.0                ],
			[config.input_width, config.input_height],
			[0.0               , config.input_height]
		];
		let four_points_size = [config.input_width, config.input_height];
		let four_points_scale = 1.0;
		let four_points_offset = [0.0, 0.0];
		if ((config.enable_transform) && (!config.only_preview)) {
			four_points = [config.p1, config.p2, config.p3, config.p4];
			four_points_size = [config.p1_p2_distance, config.p2_p3_distance];
			four_points_scale = config.transform_scale;
			four_points_offset = [config.transform_offset_x, config.transform_offset_y];
		}
		if (config.enable_correction) {
			four_points = four_points.map(src => undistortPoints(
				src, config.f, config.c, config.k, config.calib_input_scale, 1.0
			));
		}
		const t = getPerspectiveTransform(four_points, rect_scale(
			four_points_size[0], four_points_size[1],
			config.output_width, config.output_height, four_points_scale
		));
		const t2 = getPerspectiveTransform(four_points, [
			[0.0                , 0.0                ],
			[four_points_size[0], 0.0                ],
			[four_points_size[0], four_points_size[1]],
			[0.0                , four_points_size[1]]
		]);
		
		// シェーダーのuniform変数を設定
		this.graphics.shader(this.backimage_shader);
		this.backimage_shader.set("enable_correction", config.enable_correction ? 1 : 0);
		this.backimage_shader.set("enable_transform", config.enable_transform ? 1 : 0);
		this.backimage_shader.set("f", config.f[0], config.f[1]);
		this.backimage_shader.set("c", config.c[0], config.c[1]);
		this.backimage_shader.set("k", config.k[0], config.k[1], config.k[2], config.k[3]);
		this.backimage_shader.set("offset", four_points_offset[0], four_points_offset[1]);
		this.backimage_shader.set("calib_input_scale", config.calib_input_scale[0], config.calib_input_scale[1]);
		this.backimage_shader.set("t", t);
		this.backimage_shader.set("texture", this.texture);
		this.backimage_shader.set("texture_transparent", config.texture_transparent);

		// 背景にテクスチャを描画
		texture_subdivision(this.graphics, this.texture, 0, 0, config.input_width, config.input_height);
		//this.graphics.image(this.texture, 0, 0, config.input_width, config.input_height);

		// 描画する時間の範囲からフレームの範囲を取得する
		const frameRangeStatement = this.database.prepare(
			"SELECT min(frame), max(frame) FROM timestamp WHERE $start <= timestamp AND timestamp <= $stop"
		);
		const frameRange = frameRangeStatement.get({"$start": config.startTime, "$stop": config.stopTime});
		const startFrame = frameRange[0];
		const stopFrame =  frameRange[1];
		const fps = (stopFrame - startFrame) / (0.001 * (config.stopTime - config.startTime));

		// 描画するフレームの範囲内の全ての軌跡情報を取得する
		const statement = this.database.prepare(
			"SELECT * FROM trajectory WHERE $start <= frame AND frame <= $stop ORDER BY people ASC, frame ASC"
		);
		statement.bind({"$start": startFrame, "$stop": stopFrame});

		// シェーダーを設定
		this.graphics.shader(this.line_shader);

		// 取得した軌跡のデータ数だけループする
		let personID = -1;
		let drawn = false;
		//let back_real_pos = [0.0, 0.0];  // 1フレーム前の現実座標
		//let color = {r: 1.0, g: 1.0, b: 1.0};
		const meshSize = {x: config.mesh_size[0], y: config.mesh_size[1]};
		const meshMap = [...Array(meshSize.x)].map(() => Array(meshSize.y).fill(0));
		let meshCount = 0;  // その人が同じメッシュから動かなかったフレーム数
		let meshTmpPosition = {"x": -1, "y": -1};  // その人が1フレーム前にいたメッシュの座標
		// meshMap[x][y] = value;
		while (statement.step()) {
			// 次の座標を取得
			const value = statement.get();

			// 歪み補正と射影変換
			let pos = [value[2], value[3]];
			if (config.enable_correction) {
				pos = undistortPoints(pos, config.f, config.c, config.k, config.calib_input_scale, 1.0);
			}
			const screen_pos = [
				((pos[0] * t[0] + pos[1] * t[3] + t[6]) / (pos[0] * t[2] + pos[1] * t[5] + t[8])) + four_points_offset[0],
				((pos[0] * t[1] + pos[1] * t[4] + t[7]) / (pos[0] * t[2] + pos[1] * t[5] + t[8])) + four_points_offset[1]
			];
			const position = {"x": screen_pos[0], "y": screen_pos[1]};

			/*
			// 移動速度の計算 [m/s]
			let velocity = 0.0;
			const real_pos = [
				((pos[0] * t2[0] + pos[1] * t2[3] + t2[6]) / (pos[0] * t2[2] + pos[1] * t2[5] + t2[8])),
				((pos[0] * t2[1] + pos[1] * t2[4] + t2[7]) / (pos[0] * t2[2] + pos[1] * t2[5] + t2[8]))
			];
			if (config.enable_transform && (personID === value[1]) ) {
				velocity = Math.sqrt(
					((real_pos[0] - back_real_pos[0]) ** 2) + ((real_pos[1] - back_real_pos[1]) ** 2)
				) / fps;
			}
			back_real_pos = real_pos;

			// 速度が__より大きい場合には不透明度を0%にする
			const transparent = (velocity > 0.001) ? 0.0 : config.line_transparent;
			*/

			// メッシュマップの計算
			const meshPosition = {
				"x": parseInt(position.x * meshSize.x / this.plot_canvas.width),
				"y": parseInt(position.y * meshSize.y / this.plot_canvas.height)
			};
			if (personID !== value[1]) {
				meshCount = 0;
				meshTmpPosition = {"x": -1, "y": -1};
			}
			if (0 <= meshPosition.x && meshPosition.x < meshSize.x && 0 <= meshPosition.y && meshPosition.y < meshSize.y) {
				if (meshPosition.x == meshTmpPosition.x && meshPosition.y == meshTmpPosition.y) {
					meshCount += 1;
					if (meshCount >= config.mesh_countup) {
						meshMap[meshPosition.x][meshPosition.y] += 1;
						meshCount = 0;
					}
				}
				else {
					meshCount = 0;
				}
			}
			meshTmpPosition = meshPosition;

			// 人のIDが変わった場合
			if (personID !== value[1]) {
				// 前の人の軌跡の描画を終了する
				if (personID >= 0) {
					this.graphics.gshape.endWeightShape();
					this.graphics.shape(this.graphics.gshape);
				}

				// IDの記憶
				personID = value[1];

				// 色の指定
				let h = parseFloat(personID) * 0.111;
				h = h - Math.floor(h);
				const color = hsvToRgb(h, 0.5, 1.0);

				this.graphics.gshape.color(color.r, color.g, color.b, config.line_transparent);

				// 新たに軌跡の描画を開始する
				this.graphics.gshape.beginWeightShape(config.line_weight);
				drawn = true;

				// 軌跡の始点を追加
				this.graphics.gshape.vertex(position.x, position.y, 0);

				continue;
			}

			// 軌跡の追加
			this.graphics.gshape.vertex(position.x, position.y, 0);
		}

		// 最後の人の軌跡の描画を終了する
		if (drawn) {
			this.graphics.gshape.endWeightShape();
			this.graphics.shape(this.graphics.gshape);
		}

		// メッシュマップを描画する
		if (config.enable_meshmap) {
			for(let x = 0; x < meshSize.x; x++) {
				const unitX = this.plot_canvas.width / meshSize.x;
				const unitY = this.plot_canvas.height / meshSize.y;
				const screenX = x * unitX;
				for(let y = 0; y < meshSize.y; y++) {
					const screenY = y * unitY;
					const value = meshMap[x][y] / config.mesh_max;
					this.graphics.fill(255, 0, 0, value);
					this.graphics.stroke(0, 0, 0, 0);
					this.graphics.rect(screenX, screenY, unitX, unitY);
					if (screenX == 0 || screenY == 0) { continue; }
					this.graphics.stroke(255, 255, 255, 0.1);
					this.graphics.strokeWeight(1);
					this.graphics.line(screenX - 4, screenY, screenX + 4, screenY);
					this.graphics.line(screenX, screenY - 4, screenX, screenY + 4);

				}
			}
		}

		// 射影変換の4点の範囲に直線を描く
		if ((config.enable_transform) && ((config.draw_border) || (config.only_preview))) {
			this.graphics.gshape.color(1.0, 0.0, 0.0, 1.0);
			this.graphics.gshape.beginWeightShape(config.line_weight, true);
			for(let p of [config.p1, config.p2, config.p3, config.p4]) {
				// 歪み補正と射影変換
				let pos = [p[0], p[1]];
				if (config.enable_correction) {
					pos = undistortPoints(pos, config.f, config.c, config.k, config.calib_input_scale, 1.0);
				}
				pos = [
					(pos[0] * t[0] + pos[1] * t[3] + t[6]) / (pos[0] * t[2] + pos[1] * t[5] + t[8]),
					(pos[0] * t[1] + pos[1] * t[4] + t[7]) / (pos[0] * t[2] + pos[1] * t[5] + t[8])
				];
				pos[0] += four_points_offset[0];
				pos[1] += four_points_offset[1];
				this.graphics.gshape.vertex(pos[0], pos[1], 0);
			}
			this.graphics.gshape.endWeightShape();
			this.graphics.shape(this.graphics.gshape);
		}

		this.graphics.render();
	}
	loadImg(url, callback) {
		this.texture.loadImg(url, callback);
	}
};
