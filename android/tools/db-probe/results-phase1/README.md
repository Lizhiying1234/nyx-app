# Phase 1 鍘熷缁撴灉 鈥斺€?骞冲彴涓珛鍗囩骇閫昏緫 + 涓や釜 Db adapter

鏃ユ湡锛?026-08-25 路 璁惧锛歅JE110 / Android 16 路 鐩爣鐗堟湰 v34

---

## 璺戠殑鏄悓涓€浠芥湰浣?
| | 鍗囩骇閫昏緫 | adapter |
|---|---|---|
| PC锛堚憼鈶?妗ｏ級 | `src/db/upgrade.ts` | `NodeSqliteDb`锛坄node:sqlite`锛?|
| 鐪熸満锛堚憿 妗ｏ級 | **鍚屼笂锛屼竴涓瓧娌℃敼** | `CapacitorDb`锛坄@capacitor-community/sqlite` 7.0.3锛?|

鐪熸満鑴氭湰 `www/upgrade-run.js` 閲屾病鏈夊崌绾ч€昏緫 鈥斺€?瀹?`import { upgrade }`
涔嬪悗鍙仛涓や欢浜嬶細璋冪敤瀹冿紝鐒跺悗鏁板簱閲岀幇鍦ㄦ湁浠€涔堛€?
---

## 鏂囦欢

| 鏂囦欢 | 鏄粈涔?|
|---|---|
| `pc-matrix.txt` | PC 渚?24 鏉″叏缁匡紙U-0鈥-13 / N-1鈥-9 + N-6b锛?|
| `run0-three-false-reds.png` | **绗竴娆＄湡鏈鸿窇锛孭-3 / P-4 / P-5 绾?* 鈥斺€?淇濈暀瀹冿紝鍥犱负涓夋潯绾㈠叏鏄剼鎵嬫灦鐨勯棶棰橈紝涓嶆槸鍗囩骇鍣ㄧ殑 |
| `run1-all-green.png` | 淇畬涔嬪悗绗竴娆?|
| `run2-all-green.png` | 杩炵画绗簩娆★紝涓庣涓€娆′竴鑷?|

`run0` 鍊煎緱鐣欑潃锛氬畠鏄€屾祴璇曠孩浜嗕笉绛変簬浠ｇ爜閿欎簡銆嶇殑涓€涓疄渚嬶紝
涓夋潯绾㈠垎鍒槸**瀹¤鑼冨洿**鍜?*鍙栨牱鐐?*鐨勯棶棰橈紝瑙佷笅銆?
---

## 鐪熸満鍏潯锛坮un1 / run2 涓€鑷达級

| | 缁撴灉 |
|---|---|
| P-1 绌哄簱 bootstrap锛堝惈 A-1 鍙岃鍙ヨЕ鍙戝櫒鍥炲綊锛?| 鉁?瑙﹀彂鍣?32 涓?路 瀵硅薄 134 路 uv 34 路 瀛ゅ効 0 路 integrity ok |
| P-2 鏈夋暟鎹殑鏃у簱 鈫?閲嶅缓 鈽呮牳蹇?| 鉁?items 4 路 logs 24 路 cards 4 路 uv 34 路 瀛ゅ効 0 路 `updated_at` 鍚堣鍓嶅悗閫愬瓧鐩稿悓 |
| P-2b 鍚屾鐘舵€佽〃鐣欑┖ | 鉁?`row_sync_state` 0 琛?|
| P-3 涓夋潯纭害鏉熷湪鐪熸満 adapter 涓婃垚绔?鈽呮牳蹇?| 鉁?foreign_keys 鍦?BEGIN 鍓嶅叧 路 user_version 鍦ㄤ簨鍔″唴 路 瀵煎洖鍏ㄧ▼ SQL-to-SQL |
| P-4 涓€斿け璐?鈫?鏃у簱閫愰」鍘熸牱 鈽呮牳蹇?| 鉁?瀵硅薄 134/134 路 logs 24/24 路 cards 4/4 路 uv 33/33 |
| P-5 瑁佸喅娓呭崟 鈫?澶栭敭瀛ゅ効 | 鉁?鑷鎷︿笅骞跺洖婊氾紝28 澶?`review_logs鈫抜tems`锛?*涓?PC 鍚屽洜** |

P-1 椤哄甫鏄?A-1 鐨勫洖褰掞細`schema/v34.sql` 閲屾湁鍙岃鍙ヨЕ鍙戝櫒锛?adapter 鐨?`exec()` 瑕佹槸閫€鍥炴彃浠剁殑 `execute()`锛岃繖涓€鏉′細姝诲湪 `incomplete input`銆?瀹冭繃浜嗭紝灏辫瘉鏄庤蛋鐨勬槸 `run()`銆?
---

## run0 閭ｄ笁鏉＄孩鏄€庝箞鍥炰簨

**閮戒笉鏄崌绾у櫒鐨勯棶棰?*锛屼絾鍏朵腑涓€鏉℃毚闇蹭簡鍒ゆ嵁鏈韩鐨勭己闄凤紝宸蹭慨銆?
### P-3 鈥斺€?鍒ゆ嵁缂洪櫡锛堝凡淇紝褰卞搷鐢熶骇浠ｇ爜锛?
鎶ョ殑鏄€屸憽 user_version 鍐欏湪 BEGIN 涔嬪墠銆嶃€?
`AuditDb` 閭ｆ椂鍖呬綇浜?*鏁翠釜鑴氭湰**锛屽す鍏峰缓搴撴椂鍏堝啓杩囦竴娆?`pragma user_version`锛堝畬鍏ㄦ甯革級銆傛棫鍒ゆ嵁鐢?`findIndex` 鎵俱€屾暣瓒熺涓€娆″啓銆嶏紝
鎵惧埌鐨勬槸澶瑰叿閭ｄ竴娆★紝浜庢槸璇垽銆?
鍒ゆ嵁鏀规垚锛?*BEGIN 涓?COMMIT 涔嬮棿鍐欒繃灏辩畻杩?*銆?浜嬪姟涔嬪墠鍐欏灏戞閮借窡杩欐鍗囩骇鏃犲叧锛涚湡姝ｈ鎷︾殑鍙湁銆屼簨鍔￠噷娌″啓銆嶃€?PC 渚цˉ浜?`N-6b` 鎶婅繖鏉″亣绾㈤拤鎴愬洖褰掋€?
### P-4 / P-5 鈥斺€?鍙栨牱鐐归敊锛堝彧褰卞搷鐪熸満鑴氭湰锛?
`before` 蹇収鎷嶅湪銆岃鎴愪笂涓€鐗堛€?*涔嬪墠**锛屾墍浠?`uv` 涓€椤规案杩滃樊 1
锛坆efore=34銆乤fter=33锛夈€傚叾浣欐瘡涓€椤归兘鏄鐨?鈥斺€?`瀵硅薄 134/134 路 logs 24/24 路
cards 4/4` 宸茬粡璇存槑鏃у簱纭疄鍘熸牱浜嗐€傚揩鐓хЩ鍒伴檷绾т箣鍚庡嵆鍙€?
---

## 鎬庝箞閲嶈窇

```
cd tools/db-probe/device-harness
node prepare.mjs
node build-www.mjs --which upgrade
npx cap sync android
cd android && ./gradlew.bat --init-script nyx-mirrors.init.gradle installDebug
```

鐜锛圙ate 2 閭ｆ璁拌繃锛岃繖閲屽啀璁颁竴閬嶅厤寰楀啀韪╋級锛?
- `JAVA_HOME=D:\android-toolchain\jdk-21.0.12.1+1` 鈥斺€?**涓嶆槸 17**锛?  Capacitor 7 鐨?`capacitor-android` 鐢?`sourceCompatibility 21`锛?  缁?17 浼氭姤銆屾棤鏁堢殑婧愬彂琛岀増锛?1銆?- `ANDROID_HOME=D:\android-toolchain\sdk`
- Gradle 蹇呴』甯?`--init-script nyx-mirrors.init.gradle`锛堟病鏈?dl.google.com锛?- 鎴浘鐢?`adb exec-out screencap -p > x.png`锛?*瑕佸湪 Git Bash 閲岃窇** 鈥斺€?  PowerShell 鐨?`>` 浼氱粰浜岃繘鍒跺姞 BOM锛屽瓨鍑烘潵涓嶆槸 PNG
