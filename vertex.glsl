precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 matrix;
varying vec2 v_uv;
varying vec4 v_color;

uniform vec2 f;
uniform vec2 c;
uniform vec4 k;
uniform vec2 input_scale;
uniform vec2 output_scale;
uniform mat3 t;

const float PI = 3.14159265359;
const float EPS = 1e-4;

vec2 undistortPoints(vec2 src, vec2 f, vec2 c, float input_scale, float output_scale) {
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
	vec2 pos = undistortPoints(position.xy, f, c, input_scale, output_scale);
	pos = vec2(
		(pos.x * t[0][0] + pos.y * t[1][0] + t[2][0]) / (pos.x * t[0][2] + pos.y * t[1][2] + t[2][2]),
		(pos.x * t[0][1] + pos.y * t[1][1] + t[2][1]) / (pos.x * t[0][2] + pos.y * t[1][2] + t[2][2])
	);
	gl_Position = matrix * vec4(pos, 0.0, 1.0);
}