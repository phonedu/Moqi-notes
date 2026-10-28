// 桌面端入口：真正的壳在 `lib.rs`。
//
// Tauri 2 的移动端（Android）要求入口住在 lib 里并带 `mobile_entry_point`，所以壳整体搬了过去；
// 这里只负责调它——桌面与移动共用**同一份**壳，不存在两份入口各自漂移。
fn main() {
    moqi_project_b_native_lib::run();
}
