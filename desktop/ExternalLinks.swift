import Foundation

// Only explicit canonical profile, post-comment and service URLs are accepted.
// Never allow redirects, arbitrary query names, files or custom URL schemes.
func managementExternalURL(_ raw: String) -> URL? {
    guard raw.utf8.count < 200, !raw.contains("%"), !raw.contains("\\"),
          raw.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
          let parts = URLComponents(string: raw), parts.scheme == "https",
          parts.user == nil, parts.password == nil, parts.port == nil else { return nil }
    let simple = parts.query == nil && parts.fragment == nil
    let user = simple && parts.host == "weibo.cn" && parts.path.range(of: "^/u/[1-9][0-9]{4,19}$", options: .regularExpression) != nil
    let legacyPost = simple && parts.host == "www.weibo.com" && parts.path.range(of: "^/detail/[1-9][0-9]{4,19}$", options: .regularExpression) != nil
    let service = simple && parts.host == "open.weibo.com" && parts.path == "/cli/plan"
    let items = parts.queryItems ?? []
    let names = items.map { $0.name }
    let validQuery = Set(names).count == names.count && names.contains("rl") && items.allSatisfy {
        ($0.name == "rl" && ["0", "1"].contains($0.value ?? "")) || ($0.name == "uid" && $0.value?.range(of: "^[1-9][0-9]{4,19}$", options: .regularExpression) != nil)
    }
    let post = parts.host == "weibo.cn" && parts.path.range(of: "^/comment/[0-9A-Za-z]{1,12}$", options: .regularExpression) != nil && validQuery && parts.fragment == "cmtfrm"
    let webPostPath = parts.path.range(of: "^/(?:[1-9][0-9]{4,19}/[0-9A-Za-z]{1,12}|detail/[1-9][0-9]{4,19})$", options: .regularExpression) != nil
    let webPost = parts.host == "weibo.com" && webPostPath && items.count == 1 && items[0].name == "from" && items[0].value == "feed" && parts.fragment == "comment"
    guard user || legacyPost || service || post || webPost else { return nil }
    return parts.url
}


