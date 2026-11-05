fn main() {
    // The app's and its Supabase project's addresses are compiled in (src/policy.rs): rebuild when they change.
    println!("cargo:rerun-if-env-changed=ALHC_APP_URL");
    println!("cargo:rerun-if-env-changed=ALHC_SUPABASE_URL");
    tauri_build::build()
}
