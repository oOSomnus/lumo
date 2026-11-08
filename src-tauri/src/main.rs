// A Windows release build must not open a console window next to the panel.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lumo_lib::run()
}
