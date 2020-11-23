/*

魚眼レンズの歪み補正と射影変換を行うプログラムです。
(OpenCVのプログラムの一部をjavascriptに書き換えただけです。仕組みはよくわかっていません。)

魚眼レンズの歪み補正の引用元 : https://github.com/opencv/opencv/blob/4.5.0/modules/calib3d/src/fisheye.cpp#L321

*/

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