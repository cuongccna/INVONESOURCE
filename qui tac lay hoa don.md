Qui tác lấy hóa đơn từ GDT : https://hoadondientu.gdt.gov.vn/

I, Hóa đơn điện tử bán ra

1, Điều kiện lọc hóa đơn 
	- Trạng thái hóa đơn = Tất cả
	- Kết quả kiểm tra = Tất cả
	- Ngày lập hóa đơn = 1 tháng

1.1 Hóa đơn điện tử

	- Tìm kiếm

		#Headers

		Request URL : https://hoadondientu.gdt.gov.vn:30000/query/invoices/sold?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59
		Request Method : GET
		access-control-allow-origin : https://hoadondientu.gdt.gov.vn
		access-control-expose-headers : X-Total-Count
		action : tim-kiem
		content-type : application/json
		set-cookie : Merry-Christmas=708984842.12405.0000; path=/; Httponly; Secure
		strict-transport-security : max-age=31536000; includeSubDomains
		accept :application/json, text/plain, */*
		accept-encoding :gzip, deflate, br, zstd
		accept-language : vi
		action : T%C3%ACm%20ki%E1%BA%BFm%20(h%C3%B3a%20%C4%91%C6%A1n%20b%C3%A1n%20ra)
		authorization :Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDQ3NzE1LCJpYXQiOjE3NzUzNjEzMTV9.42I0UbebTst-wQJ5wGEj-alVg2cXMuZ_5JVewUz01r85l3vbmJUJ5AHa6lNfrrxD5GWJokNhfz8-MvWLsFTWRA
		connection :keep-alive
		end-point : /tra-cuu/tra-cuu-hoa-don
		host : hoadondientu.gdt.gov.vn:30000
		origin :https://hoadondientu.gdt.gov.vn
		referer :https://hoadondientu.gdt.gov.vn/
		sec-ch-ua :"Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"
		sec-ch-ua-mobile :?0
		sec-ch-ua-platform :"Windows"
		user-agent :Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0

		#payload

		sort : tdlap:desc
		size : 15 (con số này có thể đưa vào trang admin để tùy chỉnh)
		search : tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59 (thời gian tùy thuộc vào user cần lấy để đưa vào)


		#Response 

		ví dụ ( phải xây dựng đầy đủ các trường mà thuế trả về như ví dụ sau )

		{
		    "datas": [
		        {
		            "nbmst": "0319303270",
		            "khmshdon": 1,
		            "khhdon": "C26TAS",
		            "shdon": 41,
		            "cqt": "7902",
		            "cttkhac": [],
		            "dvtte": "VND",
		            "hdon": "01",
		            "hsgcma": "27526fd5-0f09-40c3-b4a8-ac8397e681b6",
		            "hsgoc": "301b2178-7f41-427e-89a0-443ed05aca06",
		            "hthdon": 1,
		            "htttoan": 9,
		            "id": "09cd25eb-d821-4a9d-99a2-3273207ee7bc",
		            "idtbao": null,
		            "khdon": null,
		            "khhdgoc": null,
		            "khmshdgoc": null,
		            "lhdgoc": null,
		            "mhdon": "00673DE0FBBE69479EA5EFB46188BBA9B1",
		            "mtdiep": null,
		            "mtdtchieu": "V0100109106E2F35C2A6B99414CBD90C15E22312430",
		            "nbdchi": "36 Bùi Thị Xuân, Phường Bến Thành, Thành phố Hồ Chí Minh, Việt Nam",
		            "chma": null,
		            "chten": null,
		            "nbhdktngay": null,
		            "nbhdktso": null,
		            "nbhdso": null,
		            "nblddnbo": null,
		            "nbptvchuyen": null,
		            "nbstkhoan": "6678 20 09 88",
		            "nbten": "CÔNG TY TNHH ANSTAR SOLUTIONS",
		            "nbtnhang": "NGÂN HÀNG TMCP VIỆT NAM THỊNH VƯỢNG - VPBANK",
		            "nbtnvchuyen": null,
		            "nbttkhac": [
		                {
		                    "ttruong": "Quận, huyện người bán",
		                    "kdlieu": "string",
		                    "dlieu": null
		                },
		                {
		                    "ttruong": "Tỉnh/Thành phố người bán",
		                    "kdlieu": "string",
		                    "dlieu": "TPHCM"
		                },
		                {
		                    "ttruong": "Mã quốc gia người bán",
		                    "kdlieu": "string",
		                    "dlieu": "84"
		                },
		                {
		                    "ttruong": "Link tra cứu người bán",
		                    "kdlieu": "string",
		                    "dlieu": null
		                }
		            ],
		            "ncma": "2026-04-03T12:49:45.757Z",
		            "ncnhat": "2026-04-03T12:49:45.764Z",
		            "ngcnhat": "tvan_viettel",
		            "nky": "2026-04-03T12:49:43Z",
		            "nmdchi": "108 Hồng Hà, Phường Tân Sơn Hòa, Thành phố Hồ Chí Minh, Việt Nam",
		            "nmmst": "0319477397",
		            "nmstkhoan": null,
		            "nmten": "CÔNG TY TNHH TM DV PHÁT TRIỂN T&A",
		            "nmtnhang": null,
		            "nmtnmua": null,
		            "nmttkhac": [
		                {
		                    "ttruong": "Loại giấy tờ người mua",
		                    "kdlieu": "string",
		                    "dlieu": null
		                },
		                {
		                    "ttruong": "Số giấy tờ người mua",
		                    "kdlieu": "string",
		                    "dlieu": null
		                }
		            ],
		            "ntao": "2026-04-03T12:49:45.722Z",
		            "ntnhan": "2026-04-03T12:49:45.681Z",
		            "pban": "2.1.0",
		            "ptgui": 1,
		            "shdgoc": null,
		            "tchat": 1,
		            "tdlap": "2026-04-02T17:00:00Z",
		            "tgia": 1.0,
		            "tgtcthue": 421000.0,
		            "tgtthue": 0.0,
		            "tgtttbchu": "Bốn trăm hai mươi mốt nghìn đồng",
		            "tgtttbso": 421000.0,
		            "thdon": "Hóa đơn giá trị gia tăng",
		            "thlap": 202604,
		            "thttlphi": [],
		            "thttltsuat": [
		                {
		                    "tsuat": "KCT",
		                    "thtien": 421000.0,
		                    "tthue": 0.0,
		                    "gttsuat": null
		                }
		            ],
		            "tlhdon": "Hóa đơn giá trị gia tăng",
		            "ttcktmai": 0.0,
		            "tthai": 4,
		            "ttkhac": [
		                {
		                    "ttruong": "Ghi chú",
		                    "kdlieu": "string",
		                    "dlieu": null
		                },
		                {
		                    "ttruong": "Trạng thái thanh toán",
		                    "kdlieu": "string",
		                    "dlieu": "Đã thanh toán"
		                },
		                {
		                    "ttruong": "Mã số bí mật",
		                    "kdlieu": "string",
		                    "dlieu": "QJDSK3S3Y61H815"
		                },
		                {
		                    "ttruong": "Ghi chú hóa đơn",
		                    "kdlieu": "string",
		                    "dlieu": null
		                }
		            ],
		            "tttbao": 1,
		            "ttttkhac": [
		                {
		                    "ttruong": "Tổng tiền thuế tiêu thụ đặc biệt",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "Tổng tiền phí",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                }
		            ],
		            "ttxly": 5,
		            "tvandnkntt": "0100109106",
		            "mhso": null,
		            "ladhddt": 1,
		            "mkhang": null,
		            "nbsdthoai": "08 8988 7988",
		            "nbdctdtu": "hotrotuvan.giaiphapcntt@gmail.com",
		            "nbfax": null,
		            "nbwebsite": null,
		            "nbcks": "{\"Subject\":\"UID=MST:0319303270,CN=CÔNG TY TNHH ANSTAR SOLUTIONS,O=CÔNG TY TNHH ANSTAR SOLUTIONS,ST=Hồ Chí Minh,C=VN\",\"SerialNumber\":\"54010E004ADFF664FB628A280A6D6B47\",\"Issuer\":\"CN=NC-CA SHA256, O=CÔNG TY CỔ PHẦN CÔNG NGHỆ NCCA, C=VN\",\"NotAfter\":\"2028-12-09T10:26:51\",\"NotBefore\":\"2025-12-10T10:26:51\",\"SigningTime\":\"2026-04-03T19:49:43\"}",
		            "nmsdthoai": null,
		            "nmdctdtu": null,
		            "nmcmnd": null,
		            "nmcks": null,
		            "bhphap": 0,
		            "hddunlap": null,
		            "gchdgoc": null,
		            "tbhgtngay": null,
		            "bhpldo": null,
		            "bhpcbo": null,
		            "bhpngay": null,
		            "tdlhdgoc": null,
		            "tgtphi": null,
		            "unhiem": null,
		            "mstdvnunlhdon": null,
		            "tdvnunlhdon": null,
		            "nbmdvqhnsach": null,
		            "nbsqdinh": null,
		            "nbncqdinh": null,
		            "nbcqcqdinh": null,
		            "nbhtban": null,
		            "nmmdvqhnsach": null,
		            "nmddvchden": null,
		            "nmtgvchdtu": null,
		            "nmtgvchdden": null,
		            "nbtnban": null,
		            "dcdvnunlhdon": null,
		            "dksbke": null,
		            "dknlbke": null,
		            "thtttoan": "TM/CK",
		            "msttcgp": "0100109106",
		            "cqtcks": "{\"Subject\":\"CN=CỤC THUẾ,O=BỘ TÀI CHÍNH,L=Hà Nội,C=VN\",\"SerialNumber\":\"2A05F812673607B0\",\"Issuer\":\"CN=CA phục vụ các cơ quan Nhà nước G2, O=Ban Cơ yếu Chính phủ, C=VN\",\"NotAfter\":\"2030-03-12T16:36:53\",\"NotBefore\":\"2025-03-13T16:36:53\",\"SigningTime\":\"2026-04-03T19:49:45\"}",
		            "gchu": "",
		            "kqcht": null,
		            "hdntgia": null,
		            "tgtkcthue": null,
		            "tgtkhac": null,
		            "nmshchieu": null,
		            "nmnchchieu": null,
		            "nmnhhhchieu": null,
		            "nmqtich": null,
		            "ktkhthue": null,
		            "nmstttoan": null,
		            "nmttttoan": null,
		            "hdhhdvu": null,
		            "qrcode": null,
		            "ttmstten": null,
		            "ladhddtten": null,
		            "hdxkhau": null,
		            "hdxkptquan": null,
		            "hdgktkhthue": null,
		            "hdonLquans": null,
		            "tthdclquan": false,
		            "pdndungs": null,
		            "hdtbssrses": null,
		            "hdTrung": null,
		            "isHDTrung": null,
		            "hdcttchinh": 0,
		            "dlhquan": null,
		            "dlnhtmai": null,
		            "bltphi": null,
		            "tcsvhdChinh": null
		        }
		    ],
		    "total": 1,
		    "state": null,
		    "time": 88
		}

	- Xem chi tiết một hóa đơn

		#Headers

		Request URL : https://hoadondientu.gdt.gov.vn:30000/query/invoices/detail?nbmst=0319303270&khhdon=C26TAS&shdon=41&khmshdon=1

		access-control-allow-origin : https://hoadondientu.gdt.gov.vn

		content-type : application/json

		end-point : /tra-cuu/tra-cuu-hoa-don

		host : hoadondientu.gdt.gov.vn:30000

		origin : https://hoadondientu.gdt.gov.vn

		referer : https://hoadondientu.gdt.gov.vn/

		#Payload

		nbmst :  0319303270
		khhdon : C26TAS
		shdon : 41
		khmshdon : 1

		#Response  (lưu ý phải thiết kế để lưu các thông tin các trường này của thuế.)

		{
		    "nbmst": "0319303270",
		    "khmshdon": 1,
		    "khhdon": "C26TAS",
		    "shdon": 41,
		    "cqt": "7902",
		    "cttkhac": [],
		    "dvtte": "VND",
		    "hdon": "01",
		    "hsgcma": "27526fd5-0f09-40c3-b4a8-ac8397e681b6",
		    "hsgoc": "301b2178-7f41-427e-89a0-443ed05aca06",
		    "hthdon": 1,
		    "htttoan": 9,
		    "id": "09cd25eb-d821-4a9d-99a2-3273207ee7bc",
		    "idtbao": null,
		    "khdon": null,
		    "khhdgoc": null,
		    "khmshdgoc": null,
		    "lhdgoc": null,
		    "mhdon": "00673DE0FBBE69479EA5EFB46188BBA9B1",
		    "mtdiep": null,
		    "mtdtchieu": "V0100109106E2F35C2A6B99414CBD90C15E22312430",
		    "nbdchi": "36 Bùi Thị Xuân, Phường Bến Thành, Thành phố Hồ Chí Minh, Việt Nam",
		    "chma": null,
		    "chten": null,
		    "nbhdktngay": null,
		    "nbhdktso": null,
		    "nbhdso": null,
		    "nblddnbo": null,
		    "nbptvchuyen": null,
		    "nbstkhoan": "6678 20 09 88",
		    "nbten": "CÔNG TY TNHH ANSTAR SOLUTIONS",
		    "nbtnhang": "NGÂN HÀNG TMCP VIỆT NAM THỊNH VƯỢNG - VPBANK",
		    "nbtnvchuyen": null,
		    "nbttkhac": [
		        {
		            "ttruong": "Quận, huyện người bán",
		            "kdlieu": "string",
		            "dlieu": null
		        },
		        {
		            "ttruong": "Tỉnh/Thành phố người bán",
		            "kdlieu": "string",
		            "dlieu": "TPHCM"
		        },
		        {
		            "ttruong": "Mã quốc gia người bán",
		            "kdlieu": "string",
		            "dlieu": "84"
		        },
		        {
		            "ttruong": "Link tra cứu người bán",
		            "kdlieu": "string",
		            "dlieu": null
		        }
		    ],
		    "ncma": "2026-04-03T12:49:45.757Z",
		    "ncnhat": "2026-04-03T12:49:45.764Z",
		    "ngcnhat": "tvan_viettel",
		    "nky": "2026-04-03T12:49:43Z",
		    "nmdchi": "108 Hồng Hà, Phường Tân Sơn Hòa, Thành phố Hồ Chí Minh, Việt Nam",
		    "nmmst": "0319477397",
		    "nmstkhoan": null,
		    "nmten": "CÔNG TY TNHH TM DV PHÁT TRIỂN T&A",
		    "nmtnhang": null,
		    "nmtnmua": null,
		    "nmttkhac": [
		        {
		            "ttruong": "Loại giấy tờ người mua",
		            "kdlieu": "string",
		            "dlieu": null
		        },
		        {
		            "ttruong": "Số giấy tờ người mua",
		            "kdlieu": "string",
		            "dlieu": null
		        }
		    ],
		    "ntao": "2026-04-03T12:49:45.722Z",
		    "ntnhan": "2026-04-03T12:49:45.681Z",
		    "pban": "2.1.0",
		    "ptgui": 1,
		    "shdgoc": null,
		    "tchat": 1,
		    "tdlap": "2026-04-02T17:00:00Z",
		    "tgia": 1.0,
		    "tgtcthue": 421000.0,
		    "tgtthue": 0.0,
		    "tgtttbchu": "Bốn trăm hai mươi mốt nghìn đồng",
		    "tgtttbso": 421000.0,
		    "thdon": "Hóa đơn giá trị gia tăng",
		    "thlap": 202604,
		    "thttlphi": [],
		    "thttltsuat": [
		        {
		            "tsuat": "KCT",
		            "thtien": 421000.0,
		            "tthue": 0.0,
		            "gttsuat": null
		        }
		    ],
		    "tlhdon": "Hóa đơn giá trị gia tăng",
		    "ttcktmai": 0.0,
		    "tthai": 4,
		    "ttkhac": [
		        {
		            "ttruong": "Ghi chú",
		            "kdlieu": "string",
		            "dlieu": null
		        },
		        {
		            "ttruong": "Trạng thái thanh toán",
		            "kdlieu": "string",
		            "dlieu": "Đã thanh toán"
		        },
		        {
		            "ttruong": "Mã số bí mật",
		            "kdlieu": "string",
		            "dlieu": "QJDSK3S3Y61H815"
		        },
		        {
		            "ttruong": "Ghi chú hóa đơn",
		            "kdlieu": "string",
		            "dlieu": null
		        }
		    ],
		    "tttbao": 1,
		    "ttttkhac": [
		        {
		            "ttruong": "Tổng tiền thuế tiêu thụ đặc biệt",
		            "kdlieu": "string",
		            "dlieu": "0"
		        },
		        {
		            "ttruong": "Tổng tiền phí",
		            "kdlieu": "string",
		            "dlieu": "0"
		        }
		    ],
		    "ttxly": 5,
		    "tvandnkntt": "0100109106",
		    "mhso": null,
		    "ladhddt": 1,
		    "mkhang": null,
		    "nbsdthoai": "08 8988 7988",
		    "nbdctdtu": "hotrotuvan.giaiphapcntt@gmail.com",
		    "nbfax": null,
		    "nbwebsite": null,
		    "nbcks": "{\"Subject\":\"UID=MST:0319303270,CN=CÔNG TY TNHH ANSTAR SOLUTIONS,O=CÔNG TY TNHH ANSTAR SOLUTIONS,ST=Hồ Chí Minh,C=VN\",\"SerialNumber\":\"54010E004ADFF664FB628A280A6D6B47\",\"Issuer\":\"CN=NC-CA SHA256, O=CÔNG TY CỔ PHẦN CÔNG NGHỆ NCCA, C=VN\",\"NotAfter\":\"2028-12-09T10:26:51\",\"NotBefore\":\"2025-12-10T10:26:51\",\"SigningTime\":\"2026-04-03T19:49:43\"}",
		    "nmsdthoai": null,
		    "nmdctdtu": null,
		    "nmcmnd": null,
		    "nmcks": null,
		    "bhphap": 0,
		    "hddunlap": null,
		    "gchdgoc": null,
		    "tbhgtngay": null,
		    "bhpldo": null,
		    "bhpcbo": null,
		    "bhpngay": null,
		    "tdlhdgoc": null,
		    "tgtphi": null,
		    "unhiem": null,
		    "mstdvnunlhdon": null,
		    "tdvnunlhdon": null,
		    "nbmdvqhnsach": null,
		    "nbsqdinh": null,
		    "nbncqdinh": null,
		    "nbcqcqdinh": null,
		    "nbhtban": null,
		    "nmmdvqhnsach": null,
		    "nmddvchden": null,
		    "nmtgvchdtu": null,
		    "nmtgvchdden": null,
		    "nbtnban": null,
		    "dcdvnunlhdon": null,
		    "dksbke": null,
		    "dknlbke": null,
		    "thtttoan": "TM/CK",
		    "msttcgp": "0100109106",
		    "cqtcks": "{\"Subject\":\"CN=CỤC THUẾ,O=BỘ TÀI CHÍNH,L=Hà Nội,C=VN\",\"SerialNumber\":\"2A05F812673607B0\",\"Issuer\":\"CN=CA phục vụ các cơ quan Nhà nước G2, O=Ban Cơ yếu Chính phủ, C=VN\",\"NotAfter\":\"2030-03-12T16:36:53\",\"NotBefore\":\"2025-03-13T16:36:53\",\"SigningTime\":\"2026-04-03T19:49:45\"}",
		    "gchu": "",
		    "kqcht": null,
		    "hdntgia": null,
		    "tgtkcthue": null,
		    "tgtkhac": null,
		    "nmshchieu": null,
		    "nmnchchieu": null,
		    "nmnhhhchieu": null,
		    "nmqtich": null,
		    "ktkhthue": null,
		    "nmstttoan": null,
		    "nmttttoan": null,
		    "hdhhdvu": [
		        {
		            "idhdon": "09cd25eb-d821-4a9d-99a2-3273207ee7bc",
		            "id": "0699357d-5d13-4e71-a37d-3d71ab4919a1",
		            "dgia": 421000.0,
		            "dvtinh": "Gói",
		            "ltsuat": "KCT",
		            "sluong": 1.0,
		            "stbchu": null,
		            "stckhau": 0.0,
		            "stt": 1,
		            "tchat": 1,
		            "ten": "Phần Mềm Hoá Đơn Điện Tử 300 số",
		            "thtcthue": null,
		            "thtien": 421000.0,
		            "tlckhau": null,
		            "tsuat": 0.0,
		            "tthue": null,
		            "sxep": 1,
		            "ttkhac": [
		                {
		                    "ttruong": "Số lô",
		                    "kdlieu": "string",
		                    "dlieu": null
		                },
		                {
		                    "ttruong": "Hạn dùng",
		                    "kdlieu": "string",
		                    "dlieu": null
		                },
		                {
		                    "ttruong": "Ghi chú dòng",
		                    "kdlieu": "string",
		                    "dlieu": null
		                },
		                {
		                    "ttruong": "Thành tiền thanh toán của hàng hóa",
		                    "kdlieu": "string",
		                    "dlieu": "421000"
		                },
		                {
		                    "ttruong": "Tiền thuế dòng (Tiền thuế GTGT)",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "Chiết khấu lần 2",
		                    "kdlieu": "string",
		                    "dlieu": null
		                }
		            ],
		            "dvtte": null,
		            "tgia": null,
		            "tthhdtrung": []
		        }
		    ],
		    "qrcode": "00020101021202000400260052005300540058005900600062009963000001100319303270020110306C26TAS0402410508202604030608421000.0",
		    "ttmstten": null,
		    "ladhddtten": null,
		    "hdxkhau": null,
		    "hdxkptquan": null,
		    "hdgktkhthue": null,
		    "hdonLquans": null,
		    "tthdclquan": false,
		    "pdndungs": null,
		    "hdtbssrses": null,
		    "hdTrung": null,
		    "isHDTrung": null,
		    "hdcttchinh": 0,
		    "dlhquan": null,
		    "dlnhtmai": null,
		    "bltphi": null,
		    "tcsvhdChinh": null
		}

	- Export excel danh sách hóa đơn tổng ( không có chi tiết )

		#Headers

		Request URL : https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-excel?sort=tdlap:desc&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59

		Request Method : GET

		access-control-allow-origin : https://hoadondientu.gdt.gov.vn
		action : ket-xuat
		content-disposition : attachment; filename=invoices.xlsx
		content-security-policy : script-src 'self'
		content-type : application/vnd.openxmlformats-officedocument.spreadsheetml.sheet

		Request Headers

		accept : application/json, text/plain, */*
		accept-encoding : gzip, deflate, br, zstd
		end-point :  /tra-cuu/tra-cuu-hoa-don
		host : hoadondientu.gdt.gov.vn:30000
		origin :https://hoadondientu.gdt.gov.vn
		referer : https://hoadondientu.gdt.gov.vn/
		sec-ch-ua : "Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"
		user-agent : Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0


		#payload 

		sort : tdlap:desc
		search : tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59


		- Export Hóa đơn (file zip chứa file chi tiết hóa đơn XML và file chứng thực)

		General 

		Request URL : https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-xml?nbmst=0319303270&khhdon=C26TAS&shdon=41&khmshdon=1
		Request Method : GET

		Response headers

		access-control-allow-origin : https://hoadondientu.gdt.gov.vn
		action :  ket-xuat-xml

		#payload

		nbmst : 0319303270
		khhdon : C26TAS
		shdon : 41
		khmshdon : 1



1.2 Hóa đơn có mã khởi tạo từ máy tính tiền

	- Tìm kiếm

		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/sold?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59", {
		  "headers": {
		    "accept": "application/json, text/plain, */*",
		    "accept-language": "vi",
		    "action": "T%C3%ACm%20ki%E1%BA%BFm%20(h%C3%B3a%20%C4%91%C6%A1n%20m%C3%A1y%20t%C3%ADnh%20ti%E1%BB%81n%20b%C3%A1n%20ra)",
		    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE4NjEzMTk5IiwidHlwZSI6MiwiZXhwIjoxNzc1NDU4NzY0LCJpYXQiOjE3NzUzNzIzNjR9.w2189iQuctS-6HqYEwk1O6yy7KLL7y4SrvtBbwtdjkRDIwH3EGfTlQ4EbaYQuOLGcy3Ugp9aCUKaHgJ6dv-ggw",
		    "end-point": "/tra-cuu/tra-cuu-hoa-don",
		    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Windows\"",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "GET",
		  "mode": "cors",
		  "credentials": "include"
		}); ;
		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/sold?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59", {
		  "headers": {
		    "accept": "*/*",
		    "accept-language": "en-US,en;q=0.9",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "OPTIONS",
		  "mode": "cors",
		  "credentials": "omit"
		});

	- Xem chi tiết 

		Tương tự "1.1 Hóa đơn điện tử"  

	- Tải danh sách hóa đơn excel

		Tương tự "1.1 Hóa đơn điện tử"  

	- Xuất hóa đơn  file zip

		Tương tự "1.1 Hóa đơn điện tử"  

II, Hóa đơn điện tử mua vào

1, Điều kiện lọc hóa đơn 
	- Trạng thái hóa đơn = Tất cả
	- Kết quả kiểm tra = (Đã cấp mã hóa đơn , Cục thuế đã nhận không mã, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền)
	- Ngày lập hóa đơn = 1 tháng

1.1 Hóa đơn điện tử

a, Đã cấp mã hóa đơn

	- Tìm kiếm

		Fetch

			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==5", {
			  "headers": {
			    "accept": "application/json, text/plain, */*",
			    "accept-language": "vi",
			    "action": "T%C3%ACm%20ki%E1%BA%BFm%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
			    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
			    "end-point": "/tra-cuu/tra-cuu-hoa-don",
			    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
			    "sec-ch-ua-mobile": "?0",
			    "sec-ch-ua-platform": "\"Windows\"",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "GET",
			  "mode": "cors",
			  "credentials": "include"
			}); ;
			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==5", {
			  "headers": {
			    "accept": "*/*",
			    "accept-language": "en-US,en;q=0.9",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "OPTIONS",
			  "mode": "cors",
			  "credentials": "omit"
			});



		Response  (ví dụ)

		{
		    "datas": [
		        {
		            "nbmst": "0106870211",
		            "khmshdon": 1,
		            "khhdon": "C26TDL",
		            "shdon": 572,
		            "cqt": "0115",
		            "cttkhac": [],
		            "dvtte": "VND",
		            "hdon": "01",
		            "hsgcma": "909638c0-0e87-455b-bb56-f6841c40d778",
		            "hsgoc": "9e059e4f-3c46-4a2a-b4b3-b6a668708026",
		            "hthdon": 1,
		            "htttoan": 9,
		            "id": "1aa0c81f-29a9-44d9-b239-4811aa5c0885",
		            "idtbao": null,
		            "khdon": null,
		            "khhdgoc": null,
		            "khmshdgoc": null,
		            "lhdgoc": null,
		            "mhdon": "000415C57340F34001A431C0E35D464943",
		            "mtdiep": null,
		            "mtdtchieu": "V031230380307314089A6F345709BF2A33591C73AA0",
		            "nbdchi": "Số 10/21 Phố Trương Công Giai, Phường Cầu Giấy, Thành phố Hà Nội, Việt Nam",
		            "chma": null,
		            "chten": null,
		            "nbhdktngay": null,
		            "nbhdktso": null,
		            "nbhdso": null,
		            "nblddnbo": null,
		            "nbptvchuyen": null,
		            "nbstkhoan": "19036187391011",
		            "nbten": "CÔNG TY CỔ PHẦN ICORP",
		            "nbtnhang": "NH TMCP Kỹ thương Việt Nam - CN Hoàng Quốc Việt - PGD Trần Thái Tông",
		            "nbtnvchuyen": null,
		            "nbttkhac": [],
		            "ncma": "2026-03-28T05:07:38.713Z",
		            "ncnhat": "2026-03-28T05:07:38.720Z",
		            "ngcnhat": "tvan_wintech",
		            "nky": "2026-03-28T05:07:35Z",
		            "nmdchi": "36 Bùi Thị Xuân, Phường Bến Thành, Thành phố Hồ Chí Minh, Việt Nam",
		            "nmmst": "0319303270",
		            "nmstkhoan": null,
		            "nmten": "CÔNG TY TNHH ANSTAR SOLUTIONS",
		            "nmtnhang": null,
		            "nmtnmua": null,
		            "nmttkhac": [],
		            "ntao": "2026-03-28T05:07:38.676Z",
		            "ntnhan": "2026-03-28T05:07:38.637Z",
		            "pban": "2.1.0",
		            "ptgui": 1,
		            "shdgoc": null,
		            "tchat": 1,
		            "tdlap": "2026-03-27T17:00:00Z",
		            "tgia": 1.0,
		            "tgtcthue": 3000000.0,
		            "tgtthue": 240000.0,
		            "tgtttbchu": "Ba triệu hai trăm bốn mươi nghìn đồng chẵn",
		            "tgtttbso": 3240000.0,
		            "thdon": "Hóa đơn xuất cho Đại lý",
		            "thlap": 202603,
		            "thttlphi": [],
		            "thttltsuat": [
		                {
		                    "tsuat": "8%",
		                    "thtien": 3000000.0,
		                    "tthue": 240000.0,
		                    "gttsuat": null
		                }
		            ],
		            "tlhdon": "Hóa đơn xuất cho Đại lý",
		            "ttcktmai": 0.0,
		            "tthai": 1,
		            "ttkhac": [
		                {
		                    "ttruong": "Mã tra cứu",
		                    "kdlieu": "string",
		                    "dlieu": "9IQM5KBW6SXN"
		                }
		            ],
		            "tttbao": 1,
		            "ttttkhac": [
		                {
		                    "ttruong": "TgTTTNTe",
		                    "kdlieu": "string",
		                    "dlieu": "3240000"
		                },
		                {
		                    "ttruong": "TTGThue",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "STTUng",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "STBNDMGiam",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "STBVTLai",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "STBNNThem",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "TTCT",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "BHYTTT",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "CPXNCV",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                },
		                {
		                    "ttruong": "CPCV",
		                    "kdlieu": "string",
		                    "dlieu": "0"
		                }
		            ],
		            "ttxly": 5,
		            "tvandnkntt": "0312303803",
		            "mhso": null,
		            "ladhddt": 1,
		            "mkhang": null,
		            "nbsdthoai": "19000099",
		            "nbdctdtu": "ketoanicorp@gmail.com",
		            "nbfax": null,
		            "nbwebsite": null,
		            "nbcks": "{\"Subject\":\"OID.0.9.2342.19200300.100.1.1=MST:0106870211, CN=CÔNG TY CỔ PHẦN ICORP, O=CÔNG TY CỔ PHẦN ICORP, S=Hà Nội, C=VN\",\"SerialNumber\":\"540112636D1E13943CB43CC5225F32CB\",\"Issuer\":\"CN=I-CA SHA-256, O=I-CA, C=VN\",\"NotAfter\":\"2028-10-20T09:45:11\",\"NotBefore\":\"2025-10-21T09:45:12\",\"SigningTime\":\"2026-03-28T12:07:35\"}",
		            "nmsdthoai": null,
		            "nmdctdtu": "anstarsolutions@gmail.com",
		            "nmcmnd": null,
		            "nmcks": null,
		            "bhphap": 0,
		            "hddunlap": null,
		            "gchdgoc": null,
		            "tbhgtngay": null,
		            "bhpldo": null,
		            "bhpcbo": null,
		            "bhpngay": null,
		            "tdlhdgoc": null,
		            "tgtphi": null,
		            "unhiem": null,
		            "mstdvnunlhdon": null,
		            "tdvnunlhdon": null,
		            "nbmdvqhnsach": null,
		            "nbsqdinh": null,
		            "nbncqdinh": null,
		            "nbcqcqdinh": null,
		            "nbhtban": null,
		            "nmmdvqhnsach": null,
		            "nmddvchden": null,
		            "nmtgvchdtu": null,
		            "nmtgvchdden": null,
		            "nbtnban": null,
		            "dcdvnunlhdon": null,
		            "dksbke": "BKHHDV001",
		            "dknlbke": "2026-03-27T17:00:00Z",
		            "thtttoan": "TM/CK",
		            "msttcgp": "0106870211",
		            "cqtcks": "{\"Subject\":\"CN=CỤC THUẾ,O=BỘ TÀI CHÍNH,L=Hà Nội,C=VN\",\"SerialNumber\":\"2A05F812673607B0\",\"Issuer\":\"CN=CA phục vụ các cơ quan Nhà nước G2, O=Ban Cơ yếu Chính phủ, C=VN\",\"NotAfter\":\"2030-03-12T16:36:53\",\"NotBefore\":\"2025-03-13T16:36:53\",\"SigningTime\":\"2026-03-28T12:07:38\"}",
		            "gchu": "",
		            "kqcht": null,
		            "hdntgia": null,
		            "tgtkcthue": null,
		            "tgtkhac": null,
		            "nmshchieu": null,
		            "nmnchchieu": null,
		            "nmnhhhchieu": null,
		            "nmqtich": null,
		            "ktkhthue": null,
		            "nmstttoan": null,
		            "nmttttoan": null,
		            "hdhhdvu": null,
		            "qrcode": null,
		            "ttmstten": null,
		            "ladhddtten": null,
		            "hdxkhau": null,
		            "hdxkptquan": null,
		            "hdgktkhthue": null,
		            "hdonLquans": null,
		            "tthdclquan": false,
		            "pdndungs": null,
		            "hdtbssrses": null,
		            "hdTrung": null,
		            "isHDTrung": null,
		            "hdcttchinh": null,
		            "dlhquan": null,
		            "dlnhtmai": null,
		            "bltphi": null,
		            "tcsvhdChinh": null
		        }
		    ],
		    "total": 1,
		    "state": null,
		    "time": 86
		}

	- Xem chi tiết hóa đơn

		Fetch

			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/detail?nbmst=0106870211&khhdon=C26TDL&shdon=572&khmshdon=1", {
			  "headers": {
			    "accept": "application/json, text/plain, */*",
			    "accept-language": "vi",
			    "action": "Xem%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
			    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
			    "end-point": "/tra-cuu/tra-cuu-hoa-don",
			    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
			    "sec-ch-ua-mobile": "?0",
			    "sec-ch-ua-platform": "\"Windows\"",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "GET",
			  "mode": "cors",
			  "credentials": "include"
			}); ;
			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/detail?nbmst=0106870211&khhdon=C26TDL&shdon=572&khmshdon=1", {
			  "headers": {
			    "accept": "*/*",
			    "accept-language": "en-US,en;q=0.9",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "OPTIONS",
			  "mode": "cors",
			  "credentials": "omit"
			});


		Response

		{"nbmst":"0106870211","khmshdon":1,"khhdon":"C26TDL","shdon":572,"cqt":"0115","cttkhac":[],"dvtte":"VND","hdon":"01","hsgcma":"909638c0-0e87-455b-bb56-f6841c40d778","hsgoc":"9e059e4f-3c46-4a2a-b4b3-b6a668708026","hthdon":1,"htttoan":9,"id":"1aa0c81f-29a9-44d9-b239-4811aa5c0885","idtbao":null,"khdon":null,"khhdgoc":null,"khmshdgoc":null,"lhdgoc":null,"mhdon":"000415C57340F34001A431C0E35D464943","mtdiep":null,"mtdtchieu":"V031230380307314089A6F345709BF2A33591C73AA0","nbdchi":"Số 10/21 Phố Trương Công Giai, Phường Cầu Giấy, Thành phố Hà Nội, Việt Nam","chma":null,"chten":null,"nbhdktngay":null,"nbhdktso":null,"nbhdso":null,"nblddnbo":null,"nbptvchuyen":null,"nbstkhoan":"19036187391011","nbten":"CÔNG TY CỔ PHẦN ICORP","nbtnhang":"NH TMCP Kỹ thương Việt Nam - CN Hoàng Quốc Việt - PGD Trần Thái Tông","nbtnvchuyen":null,"nbttkhac":[],"ncma":"2026-03-28T05:07:38.713Z","ncnhat":"2026-03-28T05:07:38.720Z","ngcnhat":"tvan_wintech","nky":"2026-03-28T05:07:35Z","nmdchi":"36 Bùi Thị Xuân, Phường Bến Thành, Thành phố Hồ Chí Minh, Việt Nam","nmmst":"0319303270","nmstkhoan":null,"nmten":"CÔNG TY TNHH ANSTAR SOLUTIONS","nmtnhang":null,"nmtnmua":null,"nmttkhac":[],"ntao":"2026-03-28T05:07:38.676Z","ntnhan":"2026-03-28T05:07:38.637Z","pban":"2.1.0","ptgui":1,"shdgoc":null,"tchat":1,"tdlap":"2026-03-27T17:00:00Z","tgia":1.0,"tgtcthue":3000000.0,"tgtthue":240000.0,"tgtttbchu":"Ba triệu hai trăm bốn mươi nghìn đồng chẵn","tgtttbso":3240000.0,"thdon":"Hóa đơn xuất cho Đại lý","thlap":202603,"thttlphi":[],"thttltsuat":[{"tsuat":"8%","thtien":3000000.0,"tthue":240000.0,"gttsuat":null}],"tlhdon":"Hóa đơn xuất cho Đại lý","ttcktmai":0.0,"tthai":1,"ttkhac":[{"ttruong":"Mã tra cứu","kdlieu":"string","dlieu":"9IQM5KBW6SXN"}],"tttbao":1,"ttttkhac":[{"ttruong":"TgTTTNTe","kdlieu":"string","dlieu":"3240000"},{"ttruong":"TTGThue","kdlieu":"string","dlieu":"0"},{"ttruong":"STTUng","kdlieu":"string","dlieu":"0"},{"ttruong":"STBNDMGiam","kdlieu":"string","dlieu":"0"},{"ttruong":"STBVTLai","kdlieu":"string","dlieu":"0"},{"ttruong":"STBNNThem","kdlieu":"string","dlieu":"0"},{"ttruong":"TTCT","kdlieu":"string","dlieu":"0"},{"ttruong":"BHYTTT","kdlieu":"string","dlieu":"0"},{"ttruong":"CPXNCV","kdlieu":"string","dlieu":"0"},{"ttruong":"CPCV","kdlieu":"string","dlieu":"0"}],"ttxly":5,"tvandnkntt":"0312303803","mhso":null,"ladhddt":1,"mkhang":null,"nbsdthoai":"19000099","nbdctdtu":"ketoanicorp@gmail.com","nbfax":null,"nbwebsite":null,"nbcks":"{\"Subject\":\"OID.0.9.2342.19200300.100.1.1=MST:0106870211, CN=CÔNG TY CỔ PHẦN ICORP, O=CÔNG TY CỔ PHẦN ICORP, S=Hà Nội, C=VN\",\"SerialNumber\":\"540112636D1E13943CB43CC5225F32CB\",\"Issuer\":\"CN=I-CA SHA-256, O=I-CA, C=VN\",\"NotAfter\":\"2028-10-20T09:45:11\",\"NotBefore\":\"2025-10-21T09:45:12\",\"SigningTime\":\"2026-03-28T12:07:35\"}","nmsdthoai":null,"nmdctdtu":"anstarsolutions@gmail.com","nmcmnd":null,"nmcks":null,"bhphap":0,"hddunlap":null,"gchdgoc":null,"tbhgtngay":null,"bhpldo":null,"bhpcbo":null,"bhpngay":null,"tdlhdgoc":null,"tgtphi":null,"unhiem":null,"mstdvnunlhdon":null,"tdvnunlhdon":null,"nbmdvqhnsach":null,"nbsqdinh":null,"nbncqdinh":null,"nbcqcqdinh":null,"nbhtban":null,"nmmdvqhnsach":null,"nmddvchden":null,"nmtgvchdtu":null,"nmtgvchdden":null,"nbtnban":null,"dcdvnunlhdon":null,"dksbke":"BKHHDV001","dknlbke":"2026-03-27T17:00:00Z","thtttoan":"TM/CK","msttcgp":"0106870211","cqtcks":"{\"Subject\":\"CN=CỤC THUẾ,O=BỘ TÀI CHÍNH,L=Hà Nội,C=VN\",\"SerialNumber\":\"2A05F812673607B0\",\"Issuer\":\"CN=CA phục vụ các cơ quan Nhà nước G2, O=Ban Cơ yếu Chính phủ, C=VN\",\"NotAfter\":\"2030-03-12T16:36:53\",\"NotBefore\":\"2025-03-13T16:36:53\",\"SigningTime\":\"2026-03-28T12:07:38\"}","gchu":"","kqcht":null,"hdntgia":null,"tgtkcthue":null,"tgtkhac":null,"nmshchieu":null,"nmnchchieu":null,"nmnhhhchieu":null,"nmqtich":null,"ktkhthue":null,"nmstttoan":null,"nmttttoan":null,"hdhhdvu":[{"idhdon":"1aa0c81f-29a9-44d9-b239-4811aa5c0885","id":"be75bbb5-f65b-4e24-9934-6119dd3d305e","dgia":150000.0,"dvtinh":"Chiếc","ltsuat":"8%","sluong":20.0,"stbchu":null,"stckhau":0.0,"stt":1,"tchat":1,"ten":"Thiết bị Token ePass2003","thtcthue":null,"thtien":3000000.0,"tlckhau":null,"tsuat":0.08,"tthue":null,"sxep":1,"ttkhac":[{"ttruong":"TThue","kdlieu":"string","dlieu":"240000"},{"ttruong":"ThTien","kdlieu":"number","dlieu":"3000000"}],"dvtte":null,"tgia":null,"tthhdtrung":[]},{"idhdon":"1aa0c81f-29a9-44d9-b239-4811aa5c0885","id":"3fd4a3bf-802f-4e23-b084-9cb3f6b6b7eb","dgia":0.0,"dvtinh":"Cái","ltsuat":"8%","sluong":20.0,"stbchu":null,"stckhau":0.0,"stt":2,"tchat":1,"ten":"Vỏ hộp chữ ký số","thtcthue":null,"thtien":0.0,"tlckhau":null,"tsuat":0.08,"tthue":null,"sxep":2,"ttkhac":[{"ttruong":"TThue","kdlieu":"string","dlieu":"0"},{"ttruong":"ThTien","kdlieu":"number","dlieu":"0"}],"dvtte":null,"tgia":null,"tthhdtrung":[]},{"idhdon":"1aa0c81f-29a9-44d9-b239-4811aa5c0885","id":"6d187db1-8bae-4cc1-96de-6e882fde4171","dgia":0.0,"dvtinh":"Cái","ltsuat":"8%","sluong":20.0,"stbchu":null,"stckhau":0.0,"stt":3,"tchat":1,"ten":"Phong bì A5","thtcthue":null,"thtien":0.0,"tlckhau":null,"tsuat":0.08,"tthue":null,"sxep":3,"ttkhac":[{"ttruong":"TThue","kdlieu":"string","dlieu":"0"},{"ttruong":"ThTien","kdlieu":"number","dlieu":"0"}],"dvtte":null,"tgia":null,"tthhdtrung":[]}],"qrcode":"00020101021202000400260052005300540058005900600062009965000001100106870211020110306C26TDL040357205082026032806093240000.0","ttmstten":null,"ladhddtten":null,"hdxkhau":null,"hdxkptquan":null,"hdgktkhthue":null,"hdonLquans":null,"tthdclquan":false,"pdndungs":null,"hdtbssrses":null,"hdTrung":null,"isHDTrung":null,"hdcttchinh":null,"dlhquan":null,"dlnhtmai":null,"bltphi":null,"tcsvhdChinh":null}


	- xuất danh sách chị tiết


		Fetch

				fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/detail?nbmst=0106870211&khhdon=C26TDL&shdon=572&khmshdon=1", {
				  "headers": {
				    "accept": "application/json, text/plain, */*",
				    "accept-language": "vi",
				    "action": "Xem%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
				    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
				    "end-point": "/tra-cuu/tra-cuu-hoa-don",
				    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
				    "sec-ch-ua-mobile": "?0",
				    "sec-ch-ua-platform": "\"Windows\"",
				    "sec-fetch-dest": "empty",
				    "sec-fetch-mode": "cors",
				    "sec-fetch-site": "same-site"
				  },
				  "referrer": "https://hoadondientu.gdt.gov.vn/",
				  "body": null,
				  "method": "GET",
				  "mode": "cors",
				  "credentials": "include"
				}); ;
				fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/detail?nbmst=0106870211&khhdon=C26TDL&shdon=572&khmshdon=1", {
				  "headers": {
				    "accept": "*/*",
				    "accept-language": "en-US,en;q=0.9",
				    "sec-fetch-dest": "empty",
				    "sec-fetch-mode": "cors",
				    "sec-fetch-site": "same-site"
				  },
				  "referrer": "https://hoadondientu.gdt.gov.vn/",
				  "body": null,
				  "method": "OPTIONS",
				  "mode": "cors",
				  "credentials": "omit"
				}); ;
				fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-excel-sold?sort=tdlap:desc&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==5%20%20%20%20&type=purchase", {
				  "headers": {
				    "accept": "application/json, text/plain, */*",
				    "accept-language": "vi",
				    "action": "Xu%E1%BA%A5t%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
				    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
				    "end-point": "/tra-cuu/tra-cuu-hoa-don",
				    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
				    "sec-ch-ua-mobile": "?0",
				    "sec-ch-ua-platform": "\"Windows\"",
				    "sec-fetch-dest": "empty",
				    "sec-fetch-mode": "cors",
				    "sec-fetch-site": "same-site"
				  },
				  "referrer": "https://hoadondientu.gdt.gov.vn/",
				  "body": null,
				  "method": "GET",
				  "mode": "cors",
				  "credentials": "include"
				}); ;
				fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-excel-sold?sort=tdlap:desc&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==5%20%20%20%20&type=purchase", {
				  "headers": {
				    "accept": "*/*",
				    "accept-language": "en-US,en;q=0.9",
				    "sec-fetch-dest": "empty",
				    "sec-fetch-mode": "cors",
				    "sec-fetch-site": "same-site"
				  },
				  "referrer": "https://hoadondientu.gdt.gov.vn/",
				  "body": null,
				  "method": "OPTIONS",
				  "mode": "cors",
				  "credentials": "omit"
				});

		Request headers

			GET /query/invoices/export-excel-sold?sort=tdlap:desc&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==5%20%20%20%20&type=purchase HTTP/1.1
			Accept: application/json, text/plain, */*
			Accept-Encoding: gzip, deflate, br, zstd
			Accept-Language: vi
			Action: Xu%E1%BA%A5t%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)
			Authorization: Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ
			Connection: keep-alive
			End-Point: /tra-cuu/tra-cuu-hoa-don
			Host: hoadondientu.gdt.gov.vn:30000
			Origin: https://hoadondientu.gdt.gov.vn
			Referer: https://hoadondientu.gdt.gov.vn/
			Sec-Fetch-Dest: empty
			Sec-Fetch-Mode: cors
			Sec-Fetch-Site: same-site
			User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0
			sec-ch-ua: "Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"
			sec-ch-ua-mobile: ?0
			sec-ch-ua-platform: "Windows"


b, Cục thuế đã nhận không mã

	- Tìm kiếm

		Fetch


			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==6", {
			  "headers": {
			    "accept": "application/json, text/plain, */*",
			    "accept-language": "vi",
			    "action": "T%C3%ACm%20ki%E1%BA%BFm%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
			    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
			    "end-point": "/tra-cuu/tra-cuu-hoa-don",
			    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
			    "sec-ch-ua-mobile": "?0",
			    "sec-ch-ua-platform": "\"Windows\"",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "GET",
			  "mode": "cors",
			  "credentials": "include"
			}); ;
			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==6", {
			  "headers": {
			    "accept": "*/*",
			    "accept-language": "en-US,en;q=0.9",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "OPTIONS",
			  "mode": "cors",
			  "credentials": "omit"
			});


		Response

			{"datas":[{"nbmst":"0100109106-122","khmshdon":1,"khhdon":"K26TVA","shdon":1078849,"cqt":"7901","cttkhac":[],"dvtte":"VND","hdon":"01","hsgcma":null,"hsgoc":null,"hthdon":2,"htttoan":null,"id":"db6e4164-12dd-4135-b65e-86f9d47beaee","idtbao":null,"khdon":null,"khhdgoc":null,"khmshdgoc":null,"lhdgoc":null,"mhdon":null,"mtdiep":null,"mtdtchieu":"V01001091069E1D815ED3444EB989D76ED525085B57","nbdchi":null,"chma":null,"chten":null,"nbhdktngay":null,"nbhdktso":null,"nbhdso":null,"nblddnbo":null,"nbptvchuyen":null,"nbstkhoan":null,"nbten":"Viettel Thành Phố Hồ Chí Minh- Chi nhánh Tập đoàn Công nghiệp - Viễn thông Quân đội","nbtnhang":null,"nbtnvchuyen":null,"nbttkhac":[],"ncma":null,"ncnhat":"2026-04-02T22:52:05.253Z","ngcnhat":null,"nky":null,"nmdchi":null,"nmmst":"0319303270","nmstkhoan":null,"nmten":"CÔNG TY TNHH ANSTAR SOLUTIONS","nmtnhang":null,"nmtnmua":null,"nmttkhac":[],"ntao":"2026-04-02T22:52:05.253Z","ntnhan":"2026-04-02T22:52:01.659Z","pban":"2.1.0","ptgui":1,"shdgoc":null,"tchat":1,"tdlap":"2026-04-01T17:00:00Z","tgia":null,"tgtcthue":389815.0,"tgtthue":31185.0,"tgtttbchu":null,"tgtttbso":421000.0,"thdon":null,"thlap":202604,"thttlphi":[],"thttltsuat":[],"tlhdon":"Hóa đơn giá trị gia tăng","ttcktmai":null,"tthai":1,"ttkhac":[],"tttbao":null,"ttttkhac":[],"ttxly":6,"tvandnkntt":"0100109106","mhso":null,"ladhddt":1,"mkhang":"","nbsdthoai":null,"nbdctdtu":null,"nbfax":null,"nbwebsite":null,"nbcks":null,"nmsdthoai":null,"nmdctdtu":null,"nmcmnd":null,"nmcks":null,"bhphap":null,"hddunlap":null,"gchdgoc":null,"tbhgtngay":null,"bhpldo":null,"bhpcbo":null,"bhpngay":null,"tdlhdgoc":null,"tgtphi":null,"unhiem":null,"mstdvnunlhdon":null,"tdvnunlhdon":null,"nbmdvqhnsach":null,"nbsqdinh":null,"nbncqdinh":null,"nbcqcqdinh":null,"nbhtban":null,"nmmdvqhnsach":null,"nmddvchden":null,"nmtgvchdtu":null,"nmtgvchdden":null,"nbtnban":"Viettel Thành Phố Hồ Chí Minh- Chi nhánh Tập đoàn Công nghiệp - Viễn thông Quân đội","dcdvnunlhdon":null,"dksbke":null,"dknlbke":null,"thtttoan":null,"msttcgp":null,"cqtcks":null,"gchu":null,"kqcht":"","hdntgia":null,"tgtkcthue":null,"tgtkhac":null,"nmshchieu":null,"nmnchchieu":null,"nmnhhhchieu":null,"nmqtich":null,"ktkhthue":null,"nmstttoan":null,"nmttttoan":null,"hdhhdvu":null,"qrcode":null,"ttmstten":null,"ladhddtten":null,"hdxkhau":null,"hdxkptquan":null,"hdgktkhthue":null,"hdonLquans":null,"tthdclquan":false,"pdndungs":null,"hdtbssrses":null,"hdTrung":null,"isHDTrung":null,"hdcttchinh":null,"dlhquan":null,"dlnhtmai":null,"bltphi":null,"tcsvhdChinh":null}],"total":1,"state":null,"time":23}


	- Xem chi tiết hóa đơn

		Fetch

			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/detail?nbmst=0100109106-122&khhdon=K26TVA&shdon=1078849&khmshdon=1", {
			  "headers": {
			    "accept": "application/json, text/plain, */*",
			    "accept-language": "vi",
			    "action": "Xem%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
			    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
			    "end-point": "/tra-cuu/tra-cuu-hoa-don",
			    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
			    "sec-ch-ua-mobile": "?0",
			    "sec-ch-ua-platform": "\"Windows\"",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "GET",
			  "mode": "cors",
			  "credentials": "include"
			}); ;
			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/detail?nbmst=0100109106-122&khhdon=K26TVA&shdon=1078849&khmshdon=1", {
			  "headers": {
			    "accept": "*/*",
			    "accept-language": "en-US,en;q=0.9",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "OPTIONS",
			  "mode": "cors",
			  "credentials": "omit"
			});


		Response 

			{"nbmst":"0100109106-122","khmshdon":1,"khhdon":"K26TVA","shdon":1078849,"cqt":"7901","cttkhac":[],"dvtte":"VND","hdon":"01","hsgcma":null,"hsgoc":null,"hthdon":2,"htttoan":null,"id":"db6e4164-12dd-4135-b65e-86f9d47beaee","idtbao":null,"khdon":null,"khhdgoc":null,"khmshdgoc":null,"lhdgoc":null,"mhdon":null,"mtdiep":null,"mtdtchieu":"V01001091069E1D815ED3444EB989D76ED525085B57","nbdchi":null,"chma":null,"chten":null,"nbhdktngay":null,"nbhdktso":null,"nbhdso":null,"nblddnbo":null,"nbptvchuyen":null,"nbstkhoan":null,"nbten":"Viettel Thành Phố Hồ Chí Minh- Chi nhánh Tập đoàn Công nghiệp - Viễn thông Quân đội","nbtnhang":null,"nbtnvchuyen":null,"nbttkhac":[],"ncma":null,"ncnhat":"2026-04-02T22:52:05.253Z","ngcnhat":null,"nky":null,"nmdchi":null,"nmmst":"0319303270","nmstkhoan":null,"nmten":"CÔNG TY TNHH ANSTAR SOLUTIONS","nmtnhang":null,"nmtnmua":null,"nmttkhac":[],"ntao":"2026-04-02T22:52:05.253Z","ntnhan":"2026-04-02T22:52:01.659Z","pban":"2.1.0","ptgui":1,"shdgoc":null,"tchat":1,"tdlap":"2026-04-01T17:00:00Z","tgia":null,"tgtcthue":389815.0,"tgtthue":31185.0,"tgtttbchu":null,"tgtttbso":421000.0,"thdon":null,"thlap":202604,"thttlphi":[],"thttltsuat":[],"tlhdon":"Hóa đơn giá trị gia tăng","ttcktmai":null,"tthai":1,"ttkhac":[],"tttbao":null,"ttttkhac":[],"ttxly":6,"tvandnkntt":"0100109106","mhso":null,"ladhddt":1,"mkhang":"","nbsdthoai":null,"nbdctdtu":null,"nbfax":null,"nbwebsite":null,"nbcks":null,"nmsdthoai":null,"nmdctdtu":null,"nmcmnd":null,"nmcks":null,"bhphap":null,"hddunlap":null,"gchdgoc":null,"tbhgtngay":null,"bhpldo":null,"bhpcbo":null,"bhpngay":null,"tdlhdgoc":null,"tgtphi":null,"unhiem":null,"mstdvnunlhdon":null,"tdvnunlhdon":null,"nbmdvqhnsach":null,"nbsqdinh":null,"nbncqdinh":null,"nbcqcqdinh":null,"nbhtban":null,"nmmdvqhnsach":null,"nmddvchden":null,"nmtgvchdtu":null,"nmtgvchdden":null,"nbtnban":"Viettel Thành Phố Hồ Chí Minh- Chi nhánh Tập đoàn Công nghiệp - Viễn thông Quân đội","dcdvnunlhdon":null,"dksbke":null,"dknlbke":null,"thtttoan":null,"msttcgp":null,"cqtcks":null,"gchu":null,"kqcht":"","hdntgia":null,"tgtkcthue":null,"tgtkhac":null,"nmshchieu":null,"nmnchchieu":null,"nmnhhhchieu":null,"nmqtich":null,"ktkhthue":null,"nmstttoan":null,"nmttttoan":null,"hdhhdvu":[{"idhdon":"db6e4164-12dd-4135-b65e-86f9d47beaee","id":"d4d96289-420c-450b-915b-94d1dc166bea","dgia":null,"dvtinh":null,"ltsuat":"8%","sluong":null,"stbchu":null,"stckhau":null,"stt":1505,"tchat":null,"ten":null,"thtcthue":null,"thtien":389815.0,"tlckhau":null,"tsuat":0.08,"tthue":31185,"sxep":1,"ttkhac":[],"dvtte":null,"tgia":null,"tthhdtrung":[]}],"qrcode":"00020101021202000400260052005300540058005900600062009972000001140100109106-122020110306K26TVA040710788490508202604020608421000.0","ttmstten":null,"ladhddtten":null,"hdxkhau":null,"hdxkptquan":null,"hdgktkhthue":null,"hdonLquans":null,"tthdclquan":false,"pdndungs":null,"hdtbssrses":null,"hdTrung":null,"isHDTrung":null,"hdcttchinh":null,"dlhquan":null,"dlnhtmai":null,"bltphi":null,"tcsvhdChinh":null}

	- Xuất danh sách hóa đơn excel

		Fetch


			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-excel-sold?sort=tdlap:desc&search=tdlap=ge=01/04/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==6%20%20%20%20&type=purchase", {
			  "headers": {
			    "accept": "application/json, text/plain, */*",
			    "accept-language": "vi",
			    "action": "Xu%E1%BA%A5t%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
			    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
			    "end-point": "/tra-cuu/tra-cuu-hoa-don",
			    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
			    "sec-ch-ua-mobile": "?0",
			    "sec-ch-ua-platform": "\"Windows\"",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "GET",
			  "mode": "cors",
			  "credentials": "include"
			}); ;
			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-excel-sold?sort=tdlap:desc&search=tdlap=ge=01/04/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==6%20%20%20%20&type=purchase", {
			  "headers": {
			    "accept": "*/*",
			    "accept-language": "en-US,en;q=0.9",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "OPTIONS",
			  "mode": "cors",
			  "credentials": "omit"
			});

	- Xuất chi tiết hóa đơn (file zip chứa xml chi tiết) loại này không xuất được

		fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-xml?nbmst=0100109106-122&khhdon=K26TVA&shdon=1078849&khmshdon=1", {
		  "headers": {
		    "accept": "application/json, text/plain, */*",
		    "accept-language": "vi",
		    "action": "Xu%E1%BA%A5t%20xml%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
		    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
		    "end-point": "/tra-cuu/tra-cuu-hoa-don",
		    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Windows\"",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "GET",
		  "mode": "cors",
		  "credentials": "include"
		}); ;
		fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/export-xml?nbmst=0100109106-122&khhdon=K26TVA&shdon=1078849&khmshdon=1", {
		  "headers": {
		    "accept": "*/*",
		    "accept-language": "en-US,en;q=0.9",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "OPTIONS",
		  "mode": "cors",
		  "credentials": "omit"
		});

		Response

		{"timestamp":"05/04/2026 13:43:25","message":"Không tồn tại hồ sơ gốc của hóa đơn.","details":"","path":"uri=/invoices/export-xml","requestId":"03d57288-0da0-4474-9ce8-1a8e6a7acbd7"}

c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền.

	- Tìm kiếm

		Fetch

			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=01/04/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==8", {
			  "headers": {
			    "accept": "application/json, text/plain, */*",
			    "accept-language": "vi",
			    "action": "T%C3%ACm%20ki%E1%BA%BFm%20(h%C3%B3a%20%C4%91%C6%A1n%20mua%20v%C3%A0o)",
			    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDU2Nzc0LCJpYXQiOjE3NzUzNzAzNzR9.-TGDt2P-V-31dRa2FtcW1L8JzoR-KlxbLGzZzTo96zqu9L23BB2ccXa1aiwyJPd5dl6ins9tq6ywooHCWelIeQ",
			    "end-point": "/tra-cuu/tra-cuu-hoa-don",
			    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
			    "sec-ch-ua-mobile": "?0",
			    "sec-ch-ua-platform": "\"Windows\"",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "GET",
			  "mode": "cors",
			  "credentials": "include"
			}); ;
			fetch("https://hoadondientu.gdt.gov.vn:30000/query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=01/04/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==8", {
			  "headers": {
			    "accept": "*/*",
			    "accept-language": "en-US,en;q=0.9",
			    "sec-fetch-dest": "empty",
			    "sec-fetch-mode": "cors",
			    "sec-fetch-site": "same-site"
			  },
			  "referrer": "https://hoadondientu.gdt.gov.vn/",
			  "body": null,
			  "method": "OPTIONS",
			  "mode": "cors",
			  "credentials": "omit"
			});

	- Xem chi tiết hóa đơn (chưa có dữ liệu để test )

		Tương tự b, Cục thuế đã nhận không mã chi khác loại ttxly==8

	- Xuất danh sách hóa đơn (chưa có dữ liệu để test )

		Tương tự b, Cục thuế đã nhận không mã chi khác loại ttxly==8

	- Tải chi tiết hóa đơn file zip (chưa có dữ liệu để test )

		Tương tự b, Cục thuế đã nhận không mã chi khác loại ttxly==8


1.2 Hóa đơn có mã khởi tạo từ máy tính tiền

a, Đã cấp mã hóa đơn

	- Tìm kiếm

		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==5", {
		  "headers": {
		    "accept": "application/json, text/plain, */*",
		    "accept-language": "vi",
		    "action": "T%C3%ACm%20ki%E1%BA%BFm%20(h%C3%B3a%20%C4%91%C6%A1n%20m%C3%A1y%20t%C3%ADnh%20ti%E1%BB%81n%20mua%20v%C3%A0o)",
		    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE4NjEzMTk5IiwidHlwZSI6MiwiZXhwIjoxNzc1NDU4NzY0LCJpYXQiOjE3NzUzNzIzNjR9.w2189iQuctS-6HqYEwk1O6yy7KLL7y4SrvtBbwtdjkRDIwH3EGfTlQ4EbaYQuOLGcy3Ugp9aCUKaHgJ6dv-ggw",
		    "end-point": "/tra-cuu/tra-cuu-hoa-don",
		    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Windows\"",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "GET",
		  "mode": "cors",
		  "credentials": "include"
		}); ;
		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==5", {
		  "headers": {
		    "accept": "*/*",
		    "accept-language": "en-US,en;q=0.9",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "OPTIONS",
		  "mode": "cors",
		  "credentials": "omit"
		});

	- Xem chi tết hóa đơn 

		giống c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền thay loại ttxly==5

	- tải danh sách hóa đơn excel

		giống c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền thay loại ttxly==5

	- Tải file zip chi tiết hóa đơn

		giống c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền thay loại ttxly==5

b, Cục thuế đã nhận không mã


	- Tìm kiếm hóa đơn

		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==6", {
		  "headers": {
		    "accept": "application/json, text/plain, */*",
		    "accept-language": "vi",
		    "action": "T%C3%ACm%20ki%E1%BA%BFm%20(h%C3%B3a%20%C4%91%C6%A1n%20m%C3%A1y%20t%C3%ADnh%20ti%E1%BB%81n%20mua%20v%C3%A0o)",
		    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE4NjEzMTk5IiwidHlwZSI6MiwiZXhwIjoxNzc1NDU4NzY0LCJpYXQiOjE3NzUzNzIzNjR9.w2189iQuctS-6HqYEwk1O6yy7KLL7y4SrvtBbwtdjkRDIwH3EGfTlQ4EbaYQuOLGcy3Ugp9aCUKaHgJ6dv-ggw",
		    "end-point": "/tra-cuu/tra-cuu-hoa-don",
		    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Windows\"",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "GET",
		  "mode": "cors",
		  "credentials": "include"
		}); ;
		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=06/03/2026T00:00:00;tdlap=le=05/04/2026T23:59:59;ttxly==6", {
		  "headers": {
		    "accept": "*/*",
		    "accept-language": "en-US,en;q=0.9",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "OPTIONS",
		  "mode": "cors",
		  "credentials": "omit"
		});

	- Xem chi tiết hóa đơn 

		giống c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền thay loại ttxly==6

	- Xuất danh sách hóa đơn excel

		giống c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền thay loại ttxly==6

	- tải file zip chi tiết hóa đơn.

		giống c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền thay loại ttxly==6

c, Cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền

	- Tìm kiếm

		# Headers

		General

		Request URL : https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/purchase?sort=tdlap:desc&size=15&search=tdlap=ge=05/03/2026T00:00:00;tdlap=le=04/04/2026T23:59:59;ttxly==8
		Request Method : GET

		Response headers


		access-control-allow-origin : https://hoadondientu.gdt.gov.vn
		action : tim-kiem
		content-type : application/json


		Request headers

		accept : application/json, text/plain, */*
		accept-encoding : gzip, deflate, br, zstd
		end-point : /tra-cuu/tra-cuu-hoa-don
		host : hoadondientu.gdt.gov.vn:30000
		origin : https://hoadondientu.gdt.gov.vn
		referer : https://hoadondientu.gdt.gov.vn/
		sec-ch-ua : "Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"
		user-agent  : Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0


		# payload

		sort : tdlap:desc
		size : 15
		search : tdlap=ge=05/03/2026T00:00:00;tdlap=le=04/04/2026T23:59:59;ttxly==8


		# Response

		{
		    "datas": [
		        {
		            "nbmst": "0102721191-001",
		            "khmshdon": 1,
		            "khhdon": "C26MCV",
		            "shdon": 1113544,
		            "cqt": "7901",
		            "cttkhac": [
		                {
		                    "ttruong": "Loại hiển thị",
		                    "kdlieu": "string",
		                    "dlieu": "HD"
		                },
		                {
		                    "ttruong": "DcCN",
		                    "kdlieu": "string",
		                    "dlieu": "Tầng 5, Lô 5-02-4 Trung Tâm Thương Mại Vạn Hạnh Mall, Số 11 Sư Vạn Hạnh, Phường Hòa Hưng, Thành phố Hồ Chí Minh, Việt Nam"
		                }
		            ],
		            "hdon": "01",
		            "hsgoc": "30252a53-9919-459f-90a1-5fe337bd089d",
		            "hthdon": 5,
		            "id": "5957ed63-6277-4b45-8d4f-f1994e564635",
		            "idtbao": null,
		            "idtbhgthdon": null,
		            "idtbhgtrinh": null,
		            "khhdgoc": null,
		            "khmshdgoc": null,
		            "lhdgoc": null,
		            "mhdon": "M1-26-LPQZG-00001114278",
		            "mtdtchieu": "V0101300842BA95E295FE274D108FC7285A3A1D7A9E",
		            "nbdchi": "Tầng 7 TTTM Gigamall, Số 240-242 Phạm Văn Đồng, Phường Hiệp Bình, TP Hồ Chí Minh",
		            "nbten": "CÔNG TY CỔ PHẦN TẬP ĐOÀN GOLDEN GATE - CHI NHÁNH MIỀN NAM",
		            "ncnhat": "2026-04-04T14:32:51.887Z",
		            "ngcnhat": null,
		            "nky": "2026-04-04T14:31:54Z",
		            "nmmst": "0319303270",
		            "nmten": "CÔNG TY TNHH ANSTAR SOLUTIONS",
		            "nmtnmua": null,
		            "ntao": "2026-04-04T14:32:51.887Z",
		            "ntnhan": "2026-04-04T14:32:24.804Z",
		            "pban": "2.1.0",
		            "ptgui": 1,
		            "shdgoc": null,
		            "tchat": 1,
		            "tdlap": "2026-04-03T17:00:00Z",
		            "tgtcthue": 1319003.0,
		            "tgtthue": 106300.0,
		            "tgtttbchu": "Một triệu bốn trăm hai mươi lăm nghìn ba trăm linh ba đồng",
		            "tgtttbso": 1425303.0,
		            "thdon": "Hóa đơn giá trị gia tăng (từ MTT)",
		            "thlap": 202604,
		            "thttltsuat": [
		                {
		                    "tsuat": "10%",
		                    "thtien": 39000.0,
		                    "tthue": 3900.0,
		                    "gttsuat": null
		                },
		                {
		                    "tsuat": "8%",
		                    "thtien": 1280003.0,
		                    "tthue": 102400.0,
		                    "gttsuat": null
		                }
		            ],
		            "tlhdon": "Hóa đơn giá trị gia tăng (từ MTT)",
		            "ttcktmai": null,
		            "tthai": 1,
		            "tttbao": 0,
		            "ttttkhac": [
		                {
		                    "ttruong": "RE",
		                    "kdlieu": "string",
		                    "dlieu": "30GG4047.04042026.2198640.121"
		                }
		            ],
		            "ttxly": 8,
		            "tvandnkntt": "0101300842",
		            "ladhddt": 1,
		            "nbsdthoai": "19006622",
		            "nbcks": "{\"Subject\":\"CN=CÔNG TY CỔ PHẦN TẬP ĐOÀN GOLDEN GATE - CHI NHÁNH MIỀN NAM, O=CÔNG TY CỔ PHẦN TẬP ĐOÀN GOLDEN GATE - CHI NHÁNH MIỀN NAM, L=\\\"Tầng 7 TTTM Gigamall, Số 240-242 Phạm Văn Đồng, Phường Hiệp Bình Chánh, Thành Phố Thủ Đức, Thành Phố Hồ Chí Minh, Việt Nam\\\", OID.0.9.2342.19200300.100.1.1=MST:0102721191-001, C=VN\",\"SerialNumber\":\"5402BC5CACCE669C2024000200089222\",\"Issuer\":\"CN=CA2, O=NACENCOMM SCT, C=VN\",\"NotAfter\":\"2026-08-24T04:26:13\",\"NotBefore\":\"2024-11-25T04:26:13\",\"SigningTime\":\"2026-04-04T21:31:54\"}",
		            "nmsdthoai": "0889887988",
		            "nmcccd": null,
		            "bhphap": 0,
		            "gchdgoc": null,
		            "tbhgtngay": null,
		            "bhpldo": null,
		            "bhpcbo": null,
		            "bhpngay": null,
		            "tdlhdgoc": null,
		            "tentvandnkntt": "tvan_thaison",
		            "kqcht": null,
		            "nbttkhac": [],
		            "nmttkhac": [],
		            "ttkhac": [
		                {
		                    "ttruong": "Mã TC",
		                    "kdlieu": "string",
		                    "dlieu": "URRQDQ5KZ"
		                },
		                {
		                    "ttruong": "Trang thái DC",
		                    "kdlieu": "string",
		                    "dlieu": "1"
		                }
		            ],
		            "nmloai": "0100",
		            "tghdmman": 0,
		            "tghdmmldo": null,
		            "cnhan": 0,
		            "kqchtmloi": [],
		            "nmdchi": "36 Bùi Thị Xuân, Phường Bến Thành, Thành phố Hồ Chí Minh, Việt Nam",
		            "chma": "30GG4047",
		            "chten": "GG Vạn Hạnh Mall HCM",
		            "nmshchieu": null,
		            "nbstkhoan": null,
		            "nbtnhang": null,
		            "nmhvtnmhang": null,
		            "thtttoan": "TM/CK",
		            "nmmdvqhnsach": null,
		            "dksbke": null,
		            "dknlbke": null,
		            "hdhhdvu": null,
		            "qrcode": null,
		            "ttmstten": null,
		            "ladhddtten": null,
		            "hdxkhau": null,
		            "hdxkptquan": null,
		            "hdgktkhthue": null,
		            "hdonLquans": null,
		            "tthdclquan": false,
		            "pdndungs": null,
		            "mtthdtbssrs": null,
		            "tcsvhdChinh": null
		        }
		    ],
		    "total": 1,
		    "state": null,
		    "time": 1844
		}

- Xem chi tiết hóa đơn


	# Headers

	General

	Request URL : https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/detail?nbmst=0102721191-001&khhdon=C26MCV&shdon=1113544&khmshdon=1
	Request Method : GET

	Response headers

	access-control-allow-origin : https://hoadondientu.gdt.gov.vn
	content-type : application/json


	Request headers

	accept : application/json, text/plain, */*
	accept-encoding : gzip, deflate, br, zstd
	end-point : /tra-cuu/tra-cuu-hoa-don
	host : hoadondientu.gdt.gov.vn:30000
	origin : https://hoadondientu.gdt.gov.vn
	referer : https://hoadondientu.gdt.gov.vn/
	sec-ch-ua : "Chromium";v="146", "Not-A.Brand";v="24", "Microsoft Edge";v="146"
	user-agent : Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0

	# payload

	nbmst : 0102721191-001
	khhdon : C26MCV
	shdon : 1113544
	khmshdon : 1

	# Response 

	ví dụ

	{
	    "nbmst": "0102721191-001",
	    "khmshdon": 1,
	    "khhdon": "C26MCV",
	    "shdon": 1113544,
	    "cqt": "7901",
	    "cttkhac": [
	        {
	            "ttruong": "Loại hiển thị",
	            "kdlieu": "string",
	            "dlieu": "HD"
	        },
	        {
	            "ttruong": "DcCN",
	            "kdlieu": "string",
	            "dlieu": "Tầng 5, Lô 5-02-4 Trung Tâm Thương Mại Vạn Hạnh Mall, Số 11 Sư Vạn Hạnh, Phường Hòa Hưng, Thành phố Hồ Chí Minh, Việt Nam"
	        }
	    ],
	    "hdon": "01",
	    "hsgoc": "30252a53-9919-459f-90a1-5fe337bd089d",
	    "hthdon": 5,
	    "id": "5957ed63-6277-4b45-8d4f-f1994e564635",
	    "idtbao": null,
	    "idtbhgthdon": null,
	    "idtbhgtrinh": null,
	    "khhdgoc": null,
	    "khmshdgoc": null,
	    "lhdgoc": null,
	    "mhdon": "M1-26-LPQZG-00001114278",
	    "mtdtchieu": "V0101300842BA95E295FE274D108FC7285A3A1D7A9E",
	    "nbdchi": "Tầng 7 TTTM Gigamall, Số 240-242 Phạm Văn Đồng, Phường Hiệp Bình, TP Hồ Chí Minh",
	    "nbten": "CÔNG TY CỔ PHẦN TẬP ĐOÀN GOLDEN GATE - CHI NHÁNH MIỀN NAM",
	    "ncnhat": "2026-04-04T14:32:51.887Z",
	    "ngcnhat": null,
	    "nky": "2026-04-04T14:31:54Z",
	    "nmmst": "0319303270",
	    "nmten": "CÔNG TY TNHH ANSTAR SOLUTIONS",
	    "nmtnmua": null,
	    "ntao": "2026-04-04T14:32:51.887Z",
	    "ntnhan": "2026-04-04T14:32:24.804Z",
	    "pban": "2.1.0",
	    "ptgui": 1,
	    "shdgoc": null,
	    "tchat": 1,
	    "tdlap": "2026-04-03T17:00:00Z",
	    "tgtcthue": 1319003.0,
	    "tgtthue": 106300.0,
	    "tgtttbchu": "Một triệu bốn trăm hai mươi lăm nghìn ba trăm linh ba đồng",
	    "tgtttbso": 1425303.0,
	    "thdon": "Hóa đơn giá trị gia tăng (từ MTT)",
	    "thlap": 202604,
	    "thttltsuat": [
	        {
	            "tsuat": "10%",
	            "thtien": 39000.0,
	            "tthue": 3900.0,
	            "gttsuat": null
	        },
	        {
	            "tsuat": "8%",
	            "thtien": 1280003.0,
	            "tthue": 102400.0,
	            "gttsuat": null
	        }
	    ],
	    "tlhdon": "Hóa đơn giá trị gia tăng (từ MTT)",
	    "ttcktmai": null,
	    "tthai": 1,
	    "tttbao": 0,
	    "ttttkhac": [
	        {
	            "ttruong": "RE",
	            "kdlieu": "string",
	            "dlieu": "30GG4047.04042026.2198640.121"
	        }
	    ],
	    "ttxly": 8,
	    "tvandnkntt": "0101300842",
	    "ladhddt": 1,
	    "nbsdthoai": "19006622",
	    "nbcks": "{\"Subject\":\"CN=CÔNG TY CỔ PHẦN TẬP ĐOÀN GOLDEN GATE - CHI NHÁNH MIỀN NAM, O=CÔNG TY CỔ PHẦN TẬP ĐOÀN GOLDEN GATE - CHI NHÁNH MIỀN NAM, L=\\\"Tầng 7 TTTM Gigamall, Số 240-242 Phạm Văn Đồng, Phường Hiệp Bình Chánh, Thành Phố Thủ Đức, Thành Phố Hồ Chí Minh, Việt Nam\\\", OID.0.9.2342.19200300.100.1.1=MST:0102721191-001, C=VN\",\"SerialNumber\":\"5402BC5CACCE669C2024000200089222\",\"Issuer\":\"CN=CA2, O=NACENCOMM SCT, C=VN\",\"NotAfter\":\"2026-08-24T04:26:13\",\"NotBefore\":\"2024-11-25T04:26:13\",\"SigningTime\":\"2026-04-04T21:31:54\"}",
	    "nmsdthoai": "0889887988",
	    "nmcccd": null,
	    "bhphap": 0,
	    "gchdgoc": null,
	    "tbhgtngay": null,
	    "bhpldo": null,
	    "bhpcbo": null,
	    "bhpngay": null,
	    "tdlhdgoc": null,
	    "tentvandnkntt": "tvan_thaison",
	    "kqcht": null,
	    "nbttkhac": [],
	    "nmttkhac": [],
	    "ttkhac": [
	        {
	            "ttruong": "Mã TC",
	            "kdlieu": "string",
	            "dlieu": "URRQDQ5KZ"
	        },
	        {
	            "ttruong": "Trang thái DC",
	            "kdlieu": "string",
	            "dlieu": "1"
	        }
	    ],
	    "nmloai": "0100",
	    "tghdmman": 0,
	    "tghdmmldo": null,
	    "cnhan": 0,
	    "kqchtmloi": [],
	    "nmdchi": "36 Bùi Thị Xuân, Phường Bến Thành, Thành phố Hồ Chí Minh, Việt Nam",
	    "chma": "30GG4047",
	    "chten": "GG Vạn Hạnh Mall HCM",
	    "nmshchieu": null,
	    "nbstkhoan": null,
	    "nbtnhang": null,
	    "nmhvtnmhang": null,
	    "thtttoan": "TM/CK",
	    "nmmdvqhnsach": null,
	    "dksbke": null,
	    "dknlbke": null,
	    "hdhhdvu": [
	        {
	            "idhdon": "5957ed63-6277-4b45-8d4f-f1994e564635",
	            "id": "ba18e3b7-4f36-4b32-90c1-e408aa852322",
	            "dgia": 399000.0,
	            "dvtinh": "Suất",
	            "ltsuat": "8%",
	            "mhhdvu": "65001944",
	            "sluong": 3.0,
	            "stbchu": null,
	            "stckhau": null,
	            "stt": 1,
	            "sxep": 1,
	            "tchat": 1,
	            "ten": "Buffet xèo xèo NL (C)",
	            "thtcthue": null,
	            "thtien": 1197000.0,
	            "tlckhau": null,
	            "tsuat": 0.08,
	            "tthue": null,
	            "ttkhac": [
	                {
	                    "ttruong": "Tiền thuế",
	                    "kdlieu": "numeric",
	                    "dlieu": "95760"
	                }
	            ],
	            "tthhdtrung": []
	        },
	        {
	            "idhdon": "5957ed63-6277-4b45-8d4f-f1994e564635",
	            "id": "71c66fa4-91b8-4f76-ae91-e2d2dbf407ad",
	            "dgia": 5000.0,
	            "dvtinh": "Cái",
	            "ltsuat": "8%",
	            "mhhdvu": "70001848",
	            "sluong": 1.0,
	            "stbchu": null,
	            "stckhau": null,
	            "stt": 2,
	            "sxep": 2,
	            "tchat": 1,
	            "ten": "Khăn giấy màng bạc Gogi",
	            "thtcthue": null,
	            "thtien": 5000.0,
	            "tlckhau": null,
	            "tsuat": 0.08,
	            "tthue": null,
	            "ttkhac": [
	                {
	                    "ttruong": "Tiền thuế",
	                    "kdlieu": "numeric",
	                    "dlieu": "400"
	                }
	            ],
	            "tthhdtrung": []
	        },
	        {
	            "idhdon": "5957ed63-6277-4b45-8d4f-f1994e564635",
	            "id": "98bb2dfe-b960-46a3-9dc4-96d40cce0146",
	            "dgia": 1.0,
	            "dvtinh": "Suất",
	            "ltsuat": "8%",
	            "mhhdvu": "65003403",
	            "sluong": 3.0,
	            "stbchu": null,
	            "stckhau": null,
	            "stt": 3,
	            "sxep": 3,
	            "tchat": 1,
	            "ten": "Vé Buffet Panchan",
	            "thtcthue": null,
	            "thtien": 3.0,
	            "tlckhau": null,
	            "tsuat": 0.08,
	            "tthue": null,
	            "ttkhac": [
	                {
	                    "ttruong": "Tiền thuế",
	                    "kdlieu": "numeric",
	                    "dlieu": "0"
	                }
	            ],
	            "tthhdtrung": []
	        },
	        {
	            "idhdon": "5957ed63-6277-4b45-8d4f-f1994e564635",
	            "id": "249b65ba-8286-4251-a69a-143749abae1e",
	            "dgia": 39000.0,
	            "dvtinh": "Lon",
	            "ltsuat": "8%",
	            "mhhdvu": "70000797",
	            "sluong": 1.0,
	            "stbchu": null,
	            "stckhau": null,
	            "stt": 4,
	            "sxep": 4,
	            "tchat": 1,
	            "ten": "Sprite (Lon)",
	            "thtcthue": null,
	            "thtien": 39000.0,
	            "tlckhau": null,
	            "tsuat": 0.08,
	            "tthue": null,
	            "ttkhac": [
	                {
	                    "ttruong": "Tiền thuế",
	                    "kdlieu": "numeric",
	                    "dlieu": "3120"
	                }
	            ],
	            "tthhdtrung": []
	        },
	        {
	            "idhdon": "5957ed63-6277-4b45-8d4f-f1994e564635",
	            "id": "4695bff8-a72a-4252-9826-2e33a37958b0",
	            "dgia": 39000.0,
	            "dvtinh": "Lon",
	            "ltsuat": "10%",
	            "mhhdvu": "70000799",
	            "sluong": 1.0,
	            "stbchu": null,
	            "stckhau": null,
	            "stt": 5,
	            "sxep": 5,
	            "tchat": 1,
	            "ten": "Coca Cola Lon 320ml",
	            "thtcthue": null,
	            "thtien": 39000.0,
	            "tlckhau": null,
	            "tsuat": 0.1,
	            "tthue": null,
	            "ttkhac": [
	                {
	                    "ttruong": "Tiền thuế",
	                    "kdlieu": "numeric",
	                    "dlieu": "3900"
	                }
	            ],
	            "tthhdtrung": []
	        },
	        {
	            "idhdon": "5957ed63-6277-4b45-8d4f-f1994e564635",
	            "id": "f104bd4b-f6ce-482f-b217-e3a7d6a2bf3a",
	            "dgia": 39000.0,
	            "dvtinh": "Suất",
	            "ltsuat": "8%",
	            "mhhdvu": "60020150",
	            "sluong": 1.0,
	            "stbchu": null,
	            "stckhau": null,
	            "stt": 6,
	            "sxep": 6,
	            "tchat": 1,
	            "ten": "Bình trà đá BV",
	            "thtcthue": null,
	            "thtien": 39000.0,
	            "tlckhau": null,
	            "tsuat": 0.08,
	            "tthue": null,
	            "ttkhac": [
	                {
	                    "ttruong": "Tiền thuế",
	                    "kdlieu": "numeric",
	                    "dlieu": "3120"
	                }
	            ],
	            "tthhdtrung": []
	        }
	    ],
	    "qrcode": "00020101021202000400260052005300540058005900600062009973000001140102721191-001020110306C26MCV0407111354405082026040406091425303.0",
	    "ttmstten": null,
	    "ladhddtten": null,
	    "hdxkhau": null,
	    "hdxkptquan": null,
	    "hdgktkhthue": null,
	    "hdonLquans": null,
	    "tthdclquan": false,
	    "pdndungs": null,
	    "mtthdtbssrs": null,
	    "tcsvhdChinh": null
	}


		Fetch

		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/detail?nbmst=0102721191-001&khhdon=C26MCV&shdon=1113544&khmshdon=1", {
		  "headers": {
		    "accept": "application/json, text/plain, */*",
		    "accept-language": "vi",
		    "action": "Xem%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20m%C3%A1y%20t%C3%ADnh%20ti%E1%BB%81n%20mua%20v%C3%A0o)",
		    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDQ3NzE1LCJpYXQiOjE3NzUzNjEzMTV9.42I0UbebTst-wQJ5wGEj-alVg2cXMuZ_5JVewUz01r85l3vbmJUJ5AHa6lNfrrxD5GWJokNhfz8-MvWLsFTWRA",
		    "end-point": "/tra-cuu/tra-cuu-hoa-don",
		    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Windows\"",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "GET",
		  "mode": "cors",
		  "credentials": "include"
		}); ;
		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/detail?nbmst=0102721191-001&khhdon=C26MCV&shdon=1113544&khmshdon=1", {
		  "headers": {
		    "accept": "*/*",
		    "accept-language": "en-US,en;q=0.9",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "OPTIONS",
		  "mode": "cors",
		  "credentials": "omit"
		});



	- Export excel danh sách hóa đơn ( chưa có chi tiết)

		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/export-excel-sold?sort=tdlap:desc&search=tdlap=ge=05/03/2026T00:00:00;tdlap=le=04/04/2026T23:59:59;ttxly==8%20%20%20%20&type=purchase", {
		  "headers": {
		    "accept": "application/json, text/plain, */*",
		    "accept-language": "vi",
		    "action": "Xu%E1%BA%A5t%20h%C3%B3a%20%C4%91%C6%A1n%20(h%C3%B3a%20%C4%91%C6%A1n%20m%C3%A1y%20t%C3%ADnh%20ti%E1%BB%81n%20mua%20v%C3%A0o)",
		    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDQ3NzE1LCJpYXQiOjE3NzUzNjEzMTV9.42I0UbebTst-wQJ5wGEj-alVg2cXMuZ_5JVewUz01r85l3vbmJUJ5AHa6lNfrrxD5GWJokNhfz8-MvWLsFTWRA",
		    "end-point": "/tra-cuu/tra-cuu-hoa-don",
		    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Windows\"",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "GET",
		  "mode": "cors",
		  "credentials": "include"
		}); ;
		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/export-excel-sold?sort=tdlap:desc&search=tdlap=ge=05/03/2026T00:00:00;tdlap=le=04/04/2026T23:59:59;ttxly==8%20%20%20%20&type=purchase", {
		  "headers": {
		    "accept": "*/*",
		    "accept-language": "en-US,en;q=0.9",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "OPTIONS",
		  "mode": "cors",
		  "credentials": "omit"
		});


	- Xuất file zip ( chưa các file xml chi tiết hóa đơn)

		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/export-xml?nbmst=0102721191-001&khhdon=C26MCV&shdon=1113544&khmshdon=1", {
		  "headers": {
		    "accept": "application/json, text/plain, */*",
		    "accept-language": "vi",
		    "action": "Xu%E1%BA%A5t%20xml%20(h%C3%B3a%20%C4%91%C6%A1n%20m%C3%A1y%20t%C3%ADnh%20ti%E1%BB%81n%20mua%20v%C3%A0o)",
		    "authorization": "Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIwMzE5MzAzMjcwIiwidHlwZSI6MiwiZXhwIjoxNzc1NDQ3NzE1LCJpYXQiOjE3NzUzNjEzMTV9.42I0UbebTst-wQJ5wGEj-alVg2cXMuZ_5JVewUz01r85l3vbmJUJ5AHa6lNfrrxD5GWJokNhfz8-MvWLsFTWRA",
		    "end-point": "/tra-cuu/tra-cuu-hoa-don",
		    "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Microsoft Edge\";v=\"146\"",
		    "sec-ch-ua-mobile": "?0",
		    "sec-ch-ua-platform": "\"Windows\"",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "GET",
		  "mode": "cors",
		  "credentials": "include"
		}); ;
		fetch("https://hoadondientu.gdt.gov.vn:30000/sco-query/invoices/export-xml?nbmst=0102721191-001&khhdon=C26MCV&shdon=1113544&khmshdon=1", {
		  "headers": {
		    "accept": "*/*",
		    "accept-language": "en-US,en;q=0.9",
		    "sec-fetch-dest": "empty",
		    "sec-fetch-mode": "cors",
		    "sec-fetch-site": "same-site"
		  },
		  "referrer": "https://hoadondientu.gdt.gov.vn/",
		  "body": null,
		  "method": "OPTIONS",
		  "mode": "cors",
		  "credentials": "omit"
		});




