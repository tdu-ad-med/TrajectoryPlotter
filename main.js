const openFile = (files) => {
	// ファイルを読み込んでいる間はぐるぐるを表示させる
	document.getElementById("error").innerHTML = "";
	document.getElementById("upload-box-main").style.visibility = "hidden";
	document.getElementById("upload-box-loading").style.visibility = "visible";

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
}, false);