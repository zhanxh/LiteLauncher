fn main() {
    // Windows 图标由 tauri-build 编入 exe 资源段（.res）。若不显式声明，
    // icon.ico 内容变更不会触发构建脚本重跑，缓存里的旧资源会被继续
    // 链接进新 exe（表现为：源码已换图标，编译产物仍是旧图标）。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
