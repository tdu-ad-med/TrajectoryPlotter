/*

数学的な処理をここにまとめました。

また、魚眼レンズの歪み補正と射影変換のプログラムはOpenCVを参考にコピペしたものです。
	魚眼レンズの歪み補正の引用元 : https://github.com/opencv/opencv/blob/4.5.0/modules/calib3d/src/fisheye.cpp#L321
	射影変換の引用元 : https://github.com/opencv/opencv/blob/4.5.0/modules/imgproc/src/imgwarp.cpp#L3276

*/



/**
 * HSVからRGBに変換する関数
 * @param h, s, v それぞれ0.0から1.0までの範囲でHSVを指定する
 * @return 0.0から1.0の範囲でのRGBの値
 */
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

/**
 * ミリ秒を"時:分:秒"形式のテキストに変換する関数
 * @param time ミリ秒単位の時間
 * @return "時:分:秒"形式のテキスト
 */
const timeFormatter = (time) => {
	sec = (Math.floor(time / 1000.0) - ((Math.floor(time / 60000.0) * 60.0)));
	min = (Math.floor(time / 60000.0) - ((Math.floor(time / 3600000.0) * 60.0)));
	hour = Math.floor(time / 3600000.0);
	return `${("00"+hour).slice(-2)}:${("00"+min).slice(-2)}:${("00"+sec).slice(-2)}`;
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
	];
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

/**
 * 1つの長方形がアスペクト比を維持したまま、もう1つの長方形に収まるような4つの頂点を求める
 * @param input_width, input_height 内側の長方形のサイズ
 * @param output_width, output_height 外側の長方形のサイズ
 * @param zoom 内側の長方形の拡大率
 * @return 変換後の内側の長方形の4点の座標
 */
const rect_scale = (input_width, input_height, output_width, output_height, zoom) => {
	const rate = (input_width / input_height) / (output_width / output_height);
	const scale = zoom * 0.5 * ((rate > 1.0) ? (output_width / input_width) : (output_height / input_height));
	const center_x = output_width / 2.0;
	const center_y = output_height / 2.0;
	input_width *= scale; input_height *= scale;
	return [
		[center_x - input_width, center_y - input_height],
		[center_x + input_width, center_y - input_height],
		[center_x + input_width, center_y + input_height],
		[center_x - input_width, center_y + input_height]
	];
};

/**
 * テクスチャを分割して描画する
 * @param 
 */
const texture_subdivision = (graphics, texture, x, y, width, height, div = 63) => {
	div += 1;
	const step = 1.0 / div;
	const width_step = step * width;
	const height_step = step * height;
	const tex_width_step = step * texture.width / texture.pow2_width;
	const tex_height_step = step * texture.height / texture.pow2_height;
	graphics.gshape.beginShape(graphics.gshape.gl.TRIANGLE_STRIP);
	for(let i = 0.0; i < div; i++) {
		const step_x = x + i * width_step;
		const tex_x = i * tex_width_step;
		const i2 = (i % 2 === 0);
		for(let j = i2 ? 0.0 : div; i2 ? (j <= div) : (j >= 0.0); j += i2 ? 1.0 : -1.0) {
			const step_y = y + j * height_step;
			const tex_y = (div - j) * tex_height_step;
			graphics.gshape.vertex(step_x             , step_y, 0, tex_x                 , tex_y);
			graphics.gshape.vertex(step_x + width_step, step_y, 0, tex_x + tex_width_step, tex_y);
		}
	}
	graphics.gshape.endShape();
	graphics.shape(graphics.gshape);
};