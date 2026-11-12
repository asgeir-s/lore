fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/macos_permissions.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("lore_permissions");
        for framework in ["AVFoundation", "Foundation", "CoreFoundation"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=src/macos_permissions.m");
    }
    tauri_build::build()
}
