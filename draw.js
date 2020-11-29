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
		this.shader = this.graphics.createShader();
		this.shader.loadShader(
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
}`
		, this.shader.default_shader.fragment);
		this.graphics.shader(this.shader);
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
					"SELECT count(*) FROM sqlite_master WHERE name IN('timestamp', 'trajectory', 'people')"
				);
				if (3 !== tableCount[0].values[0][0]) {
					this.error("このsqlファイルにはpeopleテーブル、timestampテーブル、trajectoryテーブルのいずれかが存在していません。", e);
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
		
		// シェーダーのuniform変数を設定
		this.graphics.shader(this.shader);
		this.shader.set("enable_correction", config.enable_correction ? 1 : 0);
		this.shader.set("enable_transform", config.enable_transform ? 1 : 0);
		this.shader.set("f", config.f[0], config.f[1]);
		this.shader.set("c", config.c[0], config.c[1]);
		this.shader.set("k", config.k[0], config.k[1], config.k[2], config.k[3]);
		this.shader.set("offset", four_points_offset[0], four_points_offset[1]);
		this.shader.set("calib_input_scale", config.calib_input_scale[0], config.calib_input_scale[1]);
		this.shader.set("t", t);

		// 描画する時間の範囲からフレームの範囲を取得する
		const frameRangeStatement = this.database.prepare(
			"SELECT min(frame), max(frame) FROM timestamp WHERE $start <= timestamp AND timestamp <= $stop"
		);
		const frameRange = frameRangeStatement.get({"$start": config.startTime, "$stop": config.stopTime});
		const startFrame = frameRange[0];
		const stopFrame =  frameRange[1];

		// 描画するフレームの範囲内の全ての軌跡情報を取得する
		const statement = this.database.prepare(
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
				this.graphics.gshape.vertex(position.x , position.y, 0);

				continue;
			}

			// 軌跡の追加
			this.graphics.gshape.vertex(position.x , position.y, 0);
		}

		// 最後の人の軌跡の描画を終了する
		if (drawn) {
			this.graphics.gshape.endWeightShape();
			this.graphics.shape(this.graphics.gshape);
		}

		// 射影変換の4点の範囲に直線を描く
		if ((config.enable_transform) && ((config.draw_border) || (config.only_preview))) {
			this.graphics.gshape.color(1.0, 0.0, 0.0, 1.0);
			this.graphics.gshape.beginWeightShape(config.line_weight, true);
			this.graphics.gshape.vertex(config.p1[0], config.p1[1], 0);
			this.graphics.gshape.vertex(config.p2[0], config.p2[1], 0);
			this.graphics.gshape.vertex(config.p3[0], config.p3[1], 0);
			this.graphics.gshape.vertex(config.p4[0], config.p4[1], 0);
			this.graphics.gshape.endWeightShape();
			this.graphics.shape(this.graphics.gshape);
		}

		this.graphics.render();
	}
};