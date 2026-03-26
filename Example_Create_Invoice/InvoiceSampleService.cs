using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;
using Newtonsoft.Json.Converters;

namespace ExampleCreateInvoice
{
    class InvoiceSampleService
    {
        private static readonly HttpClient client = new HttpClient();

        public async Task SearchInvoiceByTransactionUuidAsync(String accessToken)
        {
            var searchByTransUUIDDTO = new InvoiceInputWSDTO.SearchByTransUUIDDTO
            {
                supplierTaxCode = "0100109106-503",
                transactionUuid = "4849decf-02a4-435b-8949-3b89b10167df"
            };

            await PostXFormData("https://vinvoice.viettel.vn/api/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid", accessToken, searchByTransUUIDDTO);
        }

        /*API Huy hoa don*/
        public async Task CancelInvoiceAsync(String accessToken)
        {
            var cancelTransactionWSDTO = new InvoiceInputWSDTO.CancelTransactionWSDTO
            {
                supplierTaxCode = "0100109106-503",
                invoiceNo = "K25TII20",
                templateCode = "1/0230",
                strIssueDate = 1736818200000L,
                additionalReferenceDesc = "TEN VAN BAN THOA THUAN",
                additionalReferenceDate = 1587797116000L,
                reasonDelete = "Ly do xoa bo"
            };
            await PostXFormData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/cancelTransactionInvoice", accessToken, cancelTransactionWSDTO);
        }

        /*API su dung chung thu so server*/
        // - Tao moi hoa don
        public async Task CreateInvoiceGTGTAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputNewGTGT();
            await PostData($"https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }

        // - Thay the hoa don
        public async Task CreateInvoiceReplaceGTGTAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputReplaceGTGT();
            await PostData($"https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }

        // - Dieu chinh thong tin
        public async Task CreateInvoiceAdjustInfoGTGTAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputAdjustInfoGTGT();
            await PostData($"https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }

        // - Dieu chinh tien
        public async Task CreateInvoiceAdjustMoneyGTGTAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputAdjustMoneyGTGT();
            await PostData($"https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }

        // - Tao moi hoa don
        public async Task CreateInvoicePXKAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputNewPXK();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }
        // - Thay the hoa don
        public async Task CreateInvoiceReplacePXKAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputReplacePXK();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }
        // - Dieu chinh thong tin
        public async Task CreateInvoiceAdjustInfoPXKAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputAdjustInfoPXK();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }
        // - Dieu chinh tien
        public async Task CreateInvoiceAdjustMoneyPXKAsync(String accessToken)
        {
            var invoiceWSDTO = GenWSBodyInputAdjustMoneyPXK();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", accessToken, invoiceWSDTO);
        }

        public async Task CreateInvoiceBanHangAsync()
        {
            var invoiceWSDTO = GenWSBodyInputNewBanHang();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-503", "access_token", invoiceWSDTO);
        }

        public async Task CreateHashInvoiceGTGTAsync()
        {
            var invoiceWSDTO = GenWSBodyInputNewGTGT();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoiceUsbTokenGetHash/0100109106-503", "access_token", invoiceWSDTO);
        }

        public async Task CreateHashInvoicePXKAsync()
        {
            var invoiceWSDTO = GenWSBodyInputNewPXK();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoiceUsbTokenGetHash/0100109106-503", "access_token", invoiceWSDTO);
        }

        public async Task CreateHashInvoiceBanHangAsync()
        {
            var invoiceWSDTO = GenWSBodyInputNewBanHang();
            await PostData("https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoiceUsbTokenGetHash/0100109106-503", "access_token", invoiceWSDTO);
        }

        //private async Task PostXFormDataAsync(string url, string token, object data)
        //{
        //    var json = JsonConvert.SerializeObject(data);
        //    var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        //    client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        //    await client.PostAsync(url, content);
        //}

        //private async Task PostDataAsync(string url, string token, object data)
        //{
        //    var json = JsonConvert.SerializeObject(data);
        //    var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
        //    client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        //    await client.PostAsync(url, content);
        //}
        
        private async Task PostData(string url, string token, object data)
        {
            client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            var json = JsonConvert.SerializeObject(data);
            var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
            try
            {
                var response = await client.PostAsync(url, content);
                response.EnsureSuccessStatusCode();
            }catch(Exception ex)
            {
                Console.WriteLine(ex);
            }
        }

        //HOA DON THAY THE
        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputReplaceGTGT()
        {
            var invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            var generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo
            {
                invoiceType = "1",
                templateCode = "1/0173",
                invoiceSeries = "K24TJS",
                currencyCode = "VND",
                adjustmentType = "3",
                paymentStatus = true,
                transactionUuid = Guid.NewGuid().ToString(),
                adjustedNote = "Thay thế hóa đơn bị sai",
                originalInvoiceId = "K24TJS1",
                originalInvoiceIssueDate = "1736818200000",
                originalTemplateCode = "1/0173",
                additionalReferenceDesc = "VĂN BAN THOA THUAN",
                additionalReferenceDate = 1736818200000L
            };

            // invoiceWSDTO.setGeneralInvoiceInfo(generalInvoiceInfo); // Uncomment if needed
            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            var buyerInfo = new InvoiceInputWSDTO.buyerInfo
            {
                buyerName = "Nguyen Van An",
                buyerLegalName = "Cong Ty TNHH ABC",
                buyerTaxCode = "0100109106-990",
                buyerAddressLine = "Duong Le Trong Tan, Ha Dong",
                buyerPhoneNumber = "0912345678",
                buyerEmail = "abc@gmail.com",
                buyerIdNo = "030081002099",
                buyerIdType = "1",
                buyerCode = "NO_CODE",
                buyerBankName = "Ngan Hang TMCP XYZ",
                buyerBankAccount = "000193651773658",
                buyerNotGetInvoice = 1
            };
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền theo đúng hình thức của hóa đơn
            var paymentInfo = new InvoiceInputWSDTO.PaymentInfo
            {
                paymentMethodName = "TM/CK"
            };
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
            var list = new List<InvoiceInputWSDTO.ItemInfo>();
            var itemInfo = new InvoiceInputWSDTO.ItemInfo
            {
                itemCode = "HH001",
                itemName = "May tinh",
                unitName = "Chiec",
                itemNote = "Chi chu hang hoa",
                unitPrice = new decimal(15000000),
                quantity = new decimal(2),
                itemTotalAmountWithoutTax = new decimal(30000000),
                taxPercentage = new decimal(10),
                taxAmount = new decimal(3000000),
                itemTotalAmountWithTax = new decimal(33000000),
                itemTotalAmountAfterDiscount = new decimal(0),
                discount = new decimal(0),
                discount2 = new decimal(0),
                itemDiscount = new decimal(0),
                selection = 1
            };
            list.Add(itemInfo);
            invoiceWSDTO.itemInfo = list;            

            // Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Thong tin bo sung chuoi";
            info.keyTag = "invoiceNote";
            info.valueType = "text";
            infoUpdateList.Add(info);           
            invoiceWSDTO.metadata = infoUpdateList;

            // Total invoice amount
            InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
            sum.discountAmount = new decimal(0);
            sum.totalAmountWithoutTax = new decimal(30000000);
            sum.totalTaxAmount = new decimal(3000000);
            sum.totalAmountWithTax = new decimal(33000000);
            sum.totalAmountAfterDiscount = new decimal(30000000);
            invoiceWSDTO.summarizeInfo = sum;

            return invoiceWSDTO;
        }

        // HÓA ĐƠN ĐIỀU CHỈNH THÔNG TIN
        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputAdjustInfoGTGT()
        {
            InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
            generalInvoiceInfo.invoiceType = "1";
            generalInvoiceInfo.templateCode = "1/0173";
            generalInvoiceInfo.invoiceSeries = "K24TJS";
            generalInvoiceInfo.currencyCode = "VND";
            generalInvoiceInfo.adjustmentType = "1";
            generalInvoiceInfo.paymentStatus = true;
            generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
            // - Thong tin hóa đơn bị điều chỉnh thông tin
            generalInvoiceInfo.adjustmentType = "5";
            generalInvoiceInfo.adjustmentInvoiceType = "2";
            generalInvoiceInfo.adjustedNote = "Điều chỉnh thông tin hóa đơn do bi nham";
            generalInvoiceInfo.originalInvoiceId = "K24TJS1";
            generalInvoiceInfo.originalInvoiceIssueDate = "1736818200000";
            generalInvoiceInfo.originalTemplateCode = "1/0173";
            generalInvoiceInfo.additionalReferenceDesc = "VĂN BAN THOA THUAN";
            generalInvoiceInfo.additionalReferenceDate = 1605682860000;

            //generalInvoiceInfo.typeId = 1L; // Nếu phát hành tem vé, truyền id loại vé
            //generalInvoiceInfo.classifyId = 1L; // Nếu phát hành tem vé, truyền id phân loại vé (nếu có)

            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
            buyerInfo.buyerName = "Nguyen Van An";
            buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
            buyerInfo.buyerTaxCode = "0100109106-990";
            buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
            buyerInfo.buyerPhoneNumber = "0912345678";
            buyerInfo.buyerEmail = "abc@gmail.com";
            buyerInfo.buyerIdNo = "030081002099";
            buyerInfo.buyerIdType = "1";
            buyerInfo.buyerCode = "NO_CODE";
            buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
            buyerInfo.buyerBankAccount = "000193651773658";
            buyerInfo.buyerNotGetInvoice = 1;
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền theo đúng hình thức của hóa đơn
            InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
            paymentInfo.paymentMethodName = "TM/CK";
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Thong tin bo sung chuoi";
            info.keyTag = "invoiceNote";
            info.valueType = "text";
            infoUpdateList.Add(info);
            //info = new InvoiceInputWSDTO.MetaDataInfo();
            //info.numberValue = 1000L;
            //info.keyTag = "truongso";
            //info.valueType = "number";
            //infoUpdateList.Add(info);
            //info = new InvoiceInputWSDTO.MetaDataInfo();
            //info.dateValue = 167000000000L;
            //info.keyTag = "truongngay";
            //info.valueType = "date";
            //infoUpdateList.Add(info);
            invoiceWSDTO.metadata = infoUpdateList;

            return invoiceWSDTO;
        }

        //HOA DON THAY THE
private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputAdjustMoneyGTGT()
    {
        InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

        // Thong tin chung hoa don
        InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
        generalInvoiceInfo.invoiceType = "1";
        generalInvoiceInfo.templateCode = "1/0173";
        generalInvoiceInfo.invoiceSeries = "K24TJS";
        generalInvoiceInfo.currencyCode = "VND";
        generalInvoiceInfo.adjustmentType = "1";
        generalInvoiceInfo.paymentStatus = true;
        generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
        // - Thong tin hóa đơn bị điều chỉnh tiền
        generalInvoiceInfo.adjustmentType = "5";
        generalInvoiceInfo.adjustmentInvoiceType = "1";
        generalInvoiceInfo.adjustedNote = "Điều chỉnh tiền do cong nham";
        generalInvoiceInfo.originalInvoiceId = "K25TII20";
        generalInvoiceInfo.originalInvoiceIssueDate = "1736818200000";
        generalInvoiceInfo.originalTemplateCode = "1/0230";
        generalInvoiceInfo.additionalReferenceDesc = "VĂN BAN THOA THUAN";
        generalInvoiceInfo.additionalReferenceDate = 1605682860000;

       // generalInvoiceInfo.typeId = 1L; // Nếu phát hành tem vé, truyền id loại vé
        //generalInvoiceInfo.classifyId = 1L; // Nếu phát hành tem vé, truyền id phân loại vé (nếu có)

        invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

        // Thong tin nguoi mua
        InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
        buyerInfo.buyerName = "Nguyen Van An";
        buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
        buyerInfo.buyerTaxCode = "0100109106-990";
        buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
        buyerInfo.buyerPhoneNumber = "0912345678";
        buyerInfo.buyerEmail = "abc@gmail.com";
        buyerInfo.buyerIdNo = "030081002099";
        buyerInfo.buyerIdType = "1";
        buyerInfo.buyerCode = "NO_CODE";
        buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
        buyerInfo.buyerBankAccount = "000193651773658";
        buyerInfo.buyerNotGetInvoice = 1;
        invoiceWSDTO.buyerInfo = buyerInfo;

        // Hinh thuc thanh toan: Truyền theo đúng hình thức của hóa đơn
        InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
        paymentInfo.paymentMethodName = "TM/CK";
        invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

        // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
        List<InvoiceInputWSDTO.ItemInfo> list = new List<InvoiceInputWSDTO.ItemInfo>();
        InvoiceInputWSDTO.ItemInfo itemInfo = new InvoiceInputWSDTO.ItemInfo();
        itemInfo.itemCode = "HH001";
        itemInfo.itemName = "May tinh";
        itemInfo.unitName = "Chiec";
        itemInfo.itemNote = "Chi chu hang hoa";
        itemInfo.unitPrice = new decimal(15000000);
        itemInfo.quantity = new decimal(2);
        itemInfo.itemTotalAmountWithoutTax = new decimal(30000000);
        itemInfo.taxPercentage = new decimal(10);
        itemInfo.taxAmount = new decimal(3000000);
        itemInfo.itemTotalAmountWithTax = new decimal(33000000);
        itemInfo.itemTotalAmountAfterDiscount = new decimal(0);
        itemInfo.discount = new decimal(0);
        itemInfo.discount2 = new decimal(0);
        itemInfo.itemDiscount = new decimal(0);
        itemInfo.isIncreaseItem = true;
        itemInfo.selection = 1;
        list.Add(itemInfo);
        invoiceWSDTO.itemInfo = list;

        // Thong tin thue: Nếu là thuế dòng thì bỏ qua
        //InvoiceInputWSDTO.TaxBreakDownsInfo taxInfo = new InvoiceInputWSDTO.TaxBreakDownsInfo();
        //taxInfo.taxPercentage = new decimal(10);
        //taxInfo.taxableAmount = new decimal(30000000);
        //taxInfo.taxAmount = new decimal(3000000);
        //invoiceWSDTO.taxBreakdowns = new List<InvoiceInputWSDTO.TaxBreakDownsInfo> { taxInfo };

        //// Thong tin dien nuoc:
        //// - Nếu không phải hóa đơn điện nước thì bỏ qua
        //// - Nếu có thì thêm các trường dữ liệu và số lượng tương ứng
        //List<InvoiceInputWSDTO.MeterReadingInfo> meterReadingInfos = new List<InvoiceInputWSDTO.MeterReadingInfo>();
        //InvoiceInputWSDTO.MeterReadingInfo meterReadingInfo = new InvoiceInputWSDTO.MeterReadingInfo();
        //meterReadingInfo.meterName = "CS1";
        //meterReadingInfo.currentIndex = "10";
        //meterReadingInfo.previousIndex = "1";
        //meterReadingInfo.amount = "9";
        //meterReadingInfo.factor = "1";
        //meterReadingInfos.Add(meterReadingInfo);
        //invoiceWSDTO.meterReading = meterReadingInfos;

        //// Thong tin xang dau:
        //// - Nếu không phải hóa đơn xăng dầu thì bỏ qua
        //// - Nếu có thì thêm các trường dữ liệu và số lượng tương ứng
        //List<InvoiceInputWSDTO.FuelReadingInfo> fuelReadingInfos = new List<InvoiceInputWSDTO.FuelReadingInfo>();
        //InvoiceInputWSDTO.FuelReadingInfo fuelReadingInfo = new InvoiceInputWSDTO.FuelReadingInfo();
        //fuelReadingInfo.batch = "BATCH01";
        //fuelReadingInfo.idLog = "LOG10";
        //fuelReadingInfo.noteLog = "Note Log";
        //fuelReadingInfo.priceLog = new decimal(100000);
        //fuelReadingInfo.productCode = "P01";
        //fuelReadingInfo.productName = "HH 01";
        //fuelReadingInfo.pumpCode = "PUM01";
        //fuelReadingInfo.pumpName = "PUM 01";
        //fuelReadingInfo.qtyLog = new decimal(1);
        //fuelReadingInfo.thanhTienLog = new decimal(100000);
        //fuelReadingInfo.startDate = 167800000000;
        //fuelReadingInfo.endDate = 167800000000;
        //fuelReadingInfos.Add(fuelReadingInfo);
        //invoiceWSDTO.fuelReading = fuelReadingInfos;

        // Thong tin bo sung:
        // - Nếu không có thông tin bổ sung thì bỏ qua
        // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
        List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
        InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
        info.stringValue = "Thong tin bo sung chuoi";
        info.keyTag = "invoiceNote";
        info.valueType = "text";
        infoUpdateList.Add(info);
        //info = new InvoiceInputWSDTO.MetaDataInfo();
        //info.numberValue = 1000;
        //info.keyTag = "truongso";
        //info.valueType = "number";
        //infoUpdateList.Add(info);
        //info = new InvoiceInputWSDTO.MetaDataInfo();
        //info.dateValue = 167000000000;
        //info.keyTag = "truongngay";
        //info.valueType = "date";
        //infoUpdateList.Add(info);
        invoiceWSDTO.metadata = infoUpdateList;

        //Thong tin QR Code tem vé:
        // - Nếu là mẫu có QRCode thì bổ sung
        // - Không thì bỏ qua
        //InvoiceInputWSDTO.QrCodeInfo qrCodeInfoDto = new InvoiceInputWSDTO.QrCodeInfo();
        //qrCodeInfoDto.remainScan = 15;
        //qrCodeInfoDto.temposType = "LOAI VE";
        //qrCodeInfoDto.endDateQrcode = 167800000000L;
        //qrCodeInfoDto.totalScan = 15;
        //qrCodeInfoDto.startDateQrcode = 166800000000L;
        //invoiceWSDTO.qrCodeInfo = qrCodeInfoDto;

        //Tong tien hoa don
        InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
        sum.discountAmount = new decimal(0);
        sum.totalAmountWithoutTax = new decimal(30000000);
        sum.totalTaxAmount = new decimal(3000000);
        sum.totalAmountWithTax = new decimal(33000000);
        sum.totalAmountAfterDiscount = new decimal(30000000);
        invoiceWSDTO.summarizeInfo = sum;

        return invoiceWSDTO;
    }

        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputNewGTGT()
        {
            InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
            generalInvoiceInfo.templateCode = "1/0173";
            generalInvoiceInfo.invoiceSeries = "K24TJS";
            generalInvoiceInfo.currencyCode = "VND";
            generalInvoiceInfo.adjustmentType = "1";
            generalInvoiceInfo.paymentStatus = true;
            //generalInvoiceInfo.invoiceIssuedDate = 1736818200000;
            generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
            // generalInvoiceInfo.TypeId = 1; // Nếu phát hành tem vé, truyền id loại vé
            // generalInvoiceInfo.ClassifyId = 1; // Nếu phát hành tem vé, truyền id phân loại vé (nếu có)
            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
            buyerInfo.buyerName = "Nguyen Van An";
            buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
            buyerInfo.buyerTaxCode = "0100109106-990";
            buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
            buyerInfo.buyerPhoneNumber = "0912345678";
            buyerInfo.buyerEmail = "abc@gmail.com";
            buyerInfo.buyerIdNo = "030081002099";
            buyerInfo.buyerIdType = "1";
            buyerInfo.buyerCode = "NO_CODE";
            buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
            buyerInfo.buyerBankAccount = "000193651773658";
            buyerInfo.buyerNotGetInvoice = 1;
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền theo đúng hình thức của hóa đơn
            InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
            paymentInfo.paymentMethodName = "TM/CK";
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
            List<InvoiceInputWSDTO.ItemInfo> list = new List<InvoiceInputWSDTO.ItemInfo>();
            InvoiceInputWSDTO.ItemInfo itemInfo = new InvoiceInputWSDTO.ItemInfo();
            itemInfo.itemCode = "HH001";
            itemInfo.itemName = "May tinh";
            itemInfo.unitName = "Chiec";
            itemInfo.itemNote = "Chi chu hang hoa";
            itemInfo.unitPrice = new decimal(15000000);
            itemInfo.quantity = new decimal(2);
            itemInfo.itemTotalAmountWithoutTax = new decimal(30000000);
            itemInfo.taxPercentage = new decimal(10);
            itemInfo.taxAmount = new decimal(3000000);
            itemInfo.itemTotalAmountWithTax = new decimal(33000000);
            itemInfo.itemTotalAmountAfterDiscount = new decimal(0);
            itemInfo.discount = new decimal(0);
            itemInfo.discount2 = new decimal(0);
            itemInfo.itemDiscount = new decimal(0);
            itemInfo.selection = 1;
            list.Add(itemInfo);
            invoiceWSDTO.itemInfo = list;

            // Thong tin thue: Nếu là thuế dòng thì bỏ qua
            InvoiceInputWSDTO.TaxBreakDownsInfo taxInfo = new InvoiceInputWSDTO.TaxBreakDownsInfo();
            taxInfo.taxPercentage = new decimal(10);
            taxInfo.taxableAmount = new decimal(30000000);
            taxInfo.taxAmount = new decimal(3000000);
            invoiceWSDTO.taxBreakdowns
                = new List<InvoiceInputWSDTO.TaxBreakDownsInfo> { taxInfo };
            

            //Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();            
            info.stringValue = "Thong tin bo sung chuoi";
            info.keyTag = "invoiceNote";
            info.valueType = "text";
            infoUpdateList.Add(info);            
            invoiceWSDTO.metadata = infoUpdateList;

            //Tong tien hoa don
            InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
            sum.discountAmount = new decimal(0);
            sum.totalAmountWithoutTax = new decimal(30000000);
            sum.totalTaxAmount = new decimal(3000000);
            sum.totalAmountWithTax = new decimal(33000000);
            sum.totalAmountAfterDiscount = new decimal(30000000);
            invoiceWSDTO.summarizeInfo = sum;

            return invoiceWSDTO;
        }

        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputNewBanHang()
        {
            InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
            generalInvoiceInfo.templateCode = "2/0022";
            generalInvoiceInfo.invoiceSeries = "C24TAA";
            generalInvoiceInfo.currencyCode = "VND";
            generalInvoiceInfo.adjustmentType = "1";
            generalInvoiceInfo.paymentStatus = true;
            generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
            generalInvoiceInfo.typeId = 1L; // Nếu phát hành tem vé, truyền id loại vé
            generalInvoiceInfo.classifyId = 1L; // Nếu phát hành tem vé, truyền id phân loại vé (nếu có)
            generalInvoiceInfo.adjustAmount20 = "5"; // Truyền tỷ lệ tình thuế theo doanh thu của cả hóa đơn (nếu có)
            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
            buyerInfo.buyerName = "Nguyen Van An";
            buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
            buyerInfo.buyerTaxCode = "0100109106-990";
            buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
            buyerInfo.buyerPhoneNumber = "0912345678";
            buyerInfo.buyerEmail = "abc@gmail.com";
            buyerInfo.buyerIdNo = "030081002099";
            buyerInfo.buyerIdType = "1";
            buyerInfo.buyerCode = "NO_CODE";
            buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
            buyerInfo.buyerBankAccount = "000193651773658";
            buyerInfo.buyerNotGetInvoice = 1;
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền giá trị theo đúng hình thức của hóa đơn
            InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
            paymentInfo.paymentMethodName = "TM/CK";
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
            List<InvoiceInputWSDTO.ItemInfo> list = new List<InvoiceInputWSDTO.ItemInfo>();
            InvoiceInputWSDTO.ItemInfo itemInfo = new InvoiceInputWSDTO.ItemInfo();
            itemInfo.itemCode = "HH001";
            itemInfo.itemName = "May tinh";
            itemInfo.unitName = "Chiec";
            itemInfo.itemNote = "Chi chu hang hoa";
            itemInfo.unitPrice = new decimal(15000000);
            itemInfo.quantity = new decimal(2);
            itemInfo.itemTotalAmountWithoutTax = new decimal(30000000);
            itemInfo.itemTotalAmountWithTax = new decimal(30000000);
            itemInfo.itemTotalAmountAfterDiscount = new decimal(0);
            itemInfo.discount = new decimal(0);
            itemInfo.discount2 = new decimal(0);
            itemInfo.itemDiscount = new decimal(0);
            itemInfo.adjustRatio = "5"; // Truyền tỷ lệ tình thuế theo doanh thu của hàng hóa (nếu có)
            itemInfo.selection = 1;
            list.Add(itemInfo);
            invoiceWSDTO.itemInfo = list;

            // Thong tin dien nuoc:
            // - Nếu không phải hóa đơn điện nước thì bỏ qua
            // - Nếu có thì thêm các trường dữ liệu và số lượng tương ứng
            List<InvoiceInputWSDTO.MeterReadingInfo> meterReadingInfos = new List<InvoiceInputWSDTO.MeterReadingInfo>();
            InvoiceInputWSDTO.MeterReadingInfo meterReadingInfo = new InvoiceInputWSDTO.MeterReadingInfo();
            meterReadingInfo.meterName = "CS1";
            meterReadingInfo.currentIndex = "10";
            meterReadingInfo.previousIndex = "1";
            meterReadingInfo.amount = "9";
            meterReadingInfo.factor = "1";
            meterReadingInfos.Add(meterReadingInfo);
            invoiceWSDTO.meterReading = meterReadingInfos;

            // Thong tin xang dau:
            // - Nếu không phải hóa đơn xăng dầu thì bỏ qua
            // - Nếu có thì thêm các trường dữ liệu và số lượng tương ứng
            List<InvoiceInputWSDTO.FuelReadingInfo> fuelReadingInfos = new List<InvoiceInputWSDTO.FuelReadingInfo>();
            InvoiceInputWSDTO.FuelReadingInfo fuelReadingInfo = new InvoiceInputWSDTO.FuelReadingInfo();
            fuelReadingInfo.batch = "BATCH01";
            fuelReadingInfo.idLog = "LOG10";
            fuelReadingInfo.noteLog = "Note Log";
            fuelReadingInfo.priceLog = new decimal(100000);
            fuelReadingInfo.productCode = "P01";
            fuelReadingInfo.productName = "HH 01";
            fuelReadingInfo.pumpCode = "PUM01";
            fuelReadingInfo.pumpName = "PUM 01";
            fuelReadingInfo.qtyLog = new decimal(1);
            fuelReadingInfo.thanhTienLog = new decimal(100000);
            fuelReadingInfo.startDate = 167800000000L;
            fuelReadingInfo.endDate = 167800000000L;
            fuelReadingInfos.Add(fuelReadingInfo);
            invoiceWSDTO.fuelReading = fuelReadingInfos;

            // Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Thong tin bo sung chuoi";
            info.keyTag = "StringValue";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.numberValue = 1000L;
            info.keyTag = "NumberValue";
            info.valueType = "number";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.dateValue = 167000000000L;
            info.keyTag = "DateValue";
            info.valueType = "date";
            infoUpdateList.Add(info);
            invoiceWSDTO.metadata = infoUpdateList;

            // Thong tin QR Code tem vé:
            // - Nếu là mẫu có QRCode thì bổ sung
            // - Không thì bỏ qua
            InvoiceInputWSDTO.QrCodeInfo qrCodeInfoDto = new InvoiceInputWSDTO.QrCodeInfo();
            qrCodeInfoDto.remainScan = 15;
            qrCodeInfoDto.temposType = "LOAI VE";
            qrCodeInfoDto.endDateQrcode = 167800000000L;
            qrCodeInfoDto.totalScan = 15;
            qrCodeInfoDto.startDateQrcode = 166800000000L;
            invoiceWSDTO.qrCodeInfo = qrCodeInfoDto;

            // Tong tien hoa don
            InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
            sum.discountAmount = new decimal(0);
            sum.totalAmountWithoutTax = new decimal(30000000);
            sum.totalAmountWithTax = new decimal(30000000);
            sum.totalAmountAfterDiscount = new decimal(30000000);
            invoiceWSDTO.summarizeInfo = sum;

            return invoiceWSDTO;
        }

        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputNewPXK()
        {
            InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
            generalInvoiceInfo.invoiceType = "6";
            generalInvoiceInfo.templateCode = "6/1103";
            generalInvoiceInfo.invoiceSeries = "K24NAF";
            generalInvoiceInfo.currencyCode = "VND";
            generalInvoiceInfo.adjustmentType = "1";
            generalInvoiceInfo.paymentStatus = true;
            generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
            generalInvoiceInfo.typeId = 1L; // Nếu phát hành tem vé, truyền id loại vé
            generalInvoiceInfo.classifyId = 1L; // Nếu phát hành tem vé, truyền id phân loại vé (nếu có)
            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
            buyerInfo.buyerName = "Nguyen Van An";
            buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
            buyerInfo.buyerTaxCode = "0100109106-990";
            buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
            buyerInfo.buyerPhoneNumber = "0912345678";
            buyerInfo.buyerEmail = "abc@gmail.com";
            buyerInfo.buyerIdNo = "030081002099";
            buyerInfo.buyerIdType = "1";
            buyerInfo.buyerCode = "NO_CODE";
            buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
            buyerInfo.buyerBankAccount = "000193651773658";
            buyerInfo.buyerNotGetInvoice = 1;
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền giá trị theo đúng hình thức của hóa đơn
            InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
            paymentInfo.paymentMethodName = "TM/CK";
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
            List<InvoiceInputWSDTO.ItemInfo> list = new List<InvoiceInputWSDTO.ItemInfo>();
            InvoiceInputWSDTO.ItemInfo itemInfo = new InvoiceInputWSDTO.ItemInfo();
            itemInfo.itemCode = "HH001";
            itemInfo.itemName = "May tinh";
            itemInfo.unitName = "Chiec";
            itemInfo.itemNote = "Chi chu hang hoa";
            itemInfo.unitPrice = new decimal(15000000);
            itemInfo.quantity = new decimal(2);
            itemInfo.itemTotalAmountWithoutTax = new decimal(30000000);
            itemInfo.itemTotalAmountWithTax = new decimal(30000000);
            itemInfo.itemTotalAmountAfterDiscount = new decimal(0);
            itemInfo.discount = new decimal(0);
            itemInfo.discount2 = new decimal(0);
            itemInfo.itemDiscount = new decimal(0);
            itemInfo.selection = 1;
            list.Add(itemInfo);
            invoiceWSDTO.itemInfo = list;
            

            //Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Lệnh điều động nội bộ";
            info.keyTag = "economicContractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Tên người vận chuyển";
            info.keyTag = "transformer";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Phương tiện vận chuyển";
            info.keyTag = "vehicle";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Hợp đồng số (Hợp đồng vận chuyển)";
            info.keyTag = "contractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Họ và tên người xuất hàng";
            info.keyTag = "exporterName";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Xuất tại kho";
            info.keyTag = "exportAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Nhập tại kho";
            info.keyTag = "importAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Về việc";
            info.keyTag = "commandDes";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Ngày tháng năm lệnh điều động";
            info.keyTag = "commandDate";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Của";
            info.keyTag = "cua";
            info.valueType = "text";
            infoUpdateList.Add(info);
            invoiceWSDTO.metadata = infoUpdateList;
            
            // Tong tien hoa don
            InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
            sum.discountAmount = new decimal(0);
            sum.totalAmountWithoutTax = new decimal(30000000);
            sum.totalAmountWithTax = new decimal(30000000);
            sum.totalAmountAfterDiscount = new decimal(30000000);
            invoiceWSDTO.summarizeInfo = sum;

            return invoiceWSDTO;
        }

        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputReplacePXK()
        {
            InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
            generalInvoiceInfo.invoiceType = "6";
            generalInvoiceInfo.templateCode = "6/1103";
            generalInvoiceInfo.invoiceSeries = "K24NAF";
            generalInvoiceInfo.currencyCode = "VND";
            // - Thong tin hóa đơn bị thay thế            
            generalInvoiceInfo.adjustmentType = "3";
            generalInvoiceInfo.paymentStatus = true;
            generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
            generalInvoiceInfo.adjustedNote = "Thay thế hóa đơn bị sai";
            generalInvoiceInfo.originalInvoiceId = "K25NAF3";
            generalInvoiceInfo.originalInvoiceIssueDate = "1736913619000";
            generalInvoiceInfo.originalTemplateCode = "6/1103";
            generalInvoiceInfo.additionalReferenceDesc = "VĂN BAN THOA THUAN";
            generalInvoiceInfo.additionalReferenceDate = 1736818200000l;
            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
            buyerInfo.buyerName = "Nguyen Van An";
            buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
            buyerInfo.buyerTaxCode = "0100109106-990";
            buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
            buyerInfo.buyerPhoneNumber = "0912345678";
            buyerInfo.buyerEmail = "abc@gmail.com";
            buyerInfo.buyerIdNo = "030081002099";
            buyerInfo.buyerIdType = "1";
            buyerInfo.buyerCode = "NO_CODE";
            buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
            buyerInfo.buyerBankAccount = "000193651773658";
            buyerInfo.buyerNotGetInvoice = 1;
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền giá trị theo đúng hình thức của hóa đơn
            InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
            paymentInfo.paymentMethodName = "TM/CK";
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
            List<InvoiceInputWSDTO.ItemInfo> list = new List<InvoiceInputWSDTO.ItemInfo>();
            InvoiceInputWSDTO.ItemInfo itemInfo = new InvoiceInputWSDTO.ItemInfo();
            itemInfo.itemCode = "HH001";
            itemInfo.itemName = "May tinh";
            itemInfo.unitName = "Chiec";
            itemInfo.itemNote = "Chi chu hang hoa";
            itemInfo.unitPrice = new decimal(15000000);
            itemInfo.quantity = new decimal(2);
            itemInfo.itemTotalAmountWithoutTax = new decimal(30000000);
            itemInfo.itemTotalAmountWithTax = new decimal(30000000);
            itemInfo.itemTotalAmountAfterDiscount = new decimal(0);
            itemInfo.discount = new decimal(0);
            itemInfo.discount2 = new decimal(0);
            itemInfo.itemDiscount = new decimal(0);
            itemInfo.selection = 1;
            list.Add(itemInfo);
            invoiceWSDTO.itemInfo = list;


            //Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Lệnh điều động nội bộ";
            info.keyTag = "economicContractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Tên người vận chuyển";
            info.keyTag = "transformer";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Phương tiện vận chuyển";
            info.keyTag = "vehicle";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Hợp đồng số (Hợp đồng vận chuyển)";
            info.keyTag = "contractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Họ và tên người xuất hàng";
            info.keyTag = "exporterName";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Xuất tại kho";
            info.keyTag = "exportAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Nhập tại kho";
            info.keyTag = "importAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Về việc";
            info.keyTag = "commandDes";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Ngày tháng năm lệnh điều động";
            info.keyTag = "commandDate";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Của";
            info.keyTag = "cua";
            info.valueType = "text";
            infoUpdateList.Add(info);
            invoiceWSDTO.metadata = infoUpdateList;

            // Tong tien hoa don
            InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
            sum.discountAmount = new decimal(0);
            sum.totalAmountWithoutTax = new decimal(30000000);
            sum.totalAmountWithTax = new decimal(30000000);
            sum.totalAmountAfterDiscount = new decimal(30000000);
            invoiceWSDTO.summarizeInfo = sum;

            return invoiceWSDTO;
        }

        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputAdjustInfoPXK()
        {
            InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
            generalInvoiceInfo.invoiceType = "6";
            generalInvoiceInfo.templateCode = "6/1103";
            generalInvoiceInfo.invoiceSeries = "K24NAF";
            generalInvoiceInfo.currencyCode = "VND";
            // - Thong tin hóa đơn bị thay thế            
            generalInvoiceInfo.adjustmentType = "5";
            generalInvoiceInfo.paymentStatus = true;
            generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
            generalInvoiceInfo.adjustmentInvoiceType = "2";
            generalInvoiceInfo.adjustedNote = "Điều chỉnh thông tin hóa đơn do bi nham";
            generalInvoiceInfo.originalInvoiceId = "K25NAF4";
            generalInvoiceInfo.originalInvoiceIssueDate = "1736926518000";
            generalInvoiceInfo.originalTemplateCode = "6/1103";
            generalInvoiceInfo.additionalReferenceDesc = "VĂN BAN THOA THUAN";
            generalInvoiceInfo.additionalReferenceDate = 1605682860000l;
            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
            buyerInfo.buyerName = "Nguyen Van An";
            buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
            buyerInfo.buyerTaxCode = "0100109106-990";
            buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
            buyerInfo.buyerPhoneNumber = "0912345678";
            buyerInfo.buyerEmail = "abc@gmail.com";
            buyerInfo.buyerIdNo = "030081002099";
            buyerInfo.buyerIdType = "1";
            buyerInfo.buyerCode = "NO_CODE";
            buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
            buyerInfo.buyerBankAccount = "000193651773658";
            buyerInfo.buyerNotGetInvoice = 1;
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền giá trị theo đúng hình thức của hóa đơn
            InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
            paymentInfo.paymentMethodName = "TM/CK";
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
            List<InvoiceInputWSDTO.ItemInfo> list = new List<InvoiceInputWSDTO.ItemInfo>();
            InvoiceInputWSDTO.ItemInfo itemInfo = new InvoiceInputWSDTO.ItemInfo();
            itemInfo.itemCode = "HH001";
            itemInfo.itemName = "May tinh";
            itemInfo.unitName = "Chiec";
            itemInfo.itemNote = "Chi chu hang hoa";
            itemInfo.unitPrice = new decimal(15000000);
            itemInfo.quantity = new decimal(2);
            itemInfo.itemTotalAmountWithoutTax = new decimal(30000000);
            itemInfo.itemTotalAmountWithTax = new decimal(30000000);
            itemInfo.itemTotalAmountAfterDiscount = new decimal(0);
            itemInfo.discount = new decimal(0);
            itemInfo.discount2 = new decimal(0);
            itemInfo.itemDiscount = new decimal(0);
            itemInfo.selection = 1;
            list.Add(itemInfo);
            invoiceWSDTO.itemInfo = list;


            //Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Lệnh điều động nội bộ";
            info.keyTag = "economicContractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Tên người vận chuyển";
            info.keyTag = "transformer";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Phương tiện vận chuyển";
            info.keyTag = "vehicle";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Hợp đồng số (Hợp đồng vận chuyển)";
            info.keyTag = "contractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Họ và tên người xuất hàng";
            info.keyTag = "exporterName";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Xuất tại kho";
            info.keyTag = "exportAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Nhập tại kho";
            info.keyTag = "importAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Về việc";
            info.keyTag = "commandDes";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Ngày tháng năm lệnh điều động";
            info.keyTag = "commandDate";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Của";
            info.keyTag = "cua";
            info.valueType = "text";
            infoUpdateList.Add(info);
            invoiceWSDTO.metadata = infoUpdateList;

            // Tong tien hoa don
            InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
            sum.discountAmount = new decimal(0);
            sum.totalAmountWithoutTax = new decimal(30000000);
            sum.totalAmountWithTax = new decimal(30000000);
            sum.totalAmountAfterDiscount = new decimal(30000000);
            invoiceWSDTO.summarizeInfo = sum;

            return invoiceWSDTO;
        }

        private InvoiceInputWSDTO.CreateInvoiceWSDTO GenWSBodyInputAdjustMoneyPXK()
        {
            InvoiceInputWSDTO.CreateInvoiceWSDTO invoiceWSDTO = new InvoiceInputWSDTO.CreateInvoiceWSDTO();

            // Thong tin chung hoa don
            InvoiceInputWSDTO.GeneralInvoiceInfo generalInvoiceInfo = new InvoiceInputWSDTO.GeneralInvoiceInfo();
            generalInvoiceInfo.invoiceType = "6";
            generalInvoiceInfo.templateCode = "6/1103";
            generalInvoiceInfo.invoiceSeries = "K24NAF";
            generalInvoiceInfo.currencyCode = "VND";
            // - Thong tin hóa đơn bị thay thế            
            generalInvoiceInfo.adjustmentType = "5";
            generalInvoiceInfo.paymentStatus = true;
            generalInvoiceInfo.transactionUuid = Guid.NewGuid().ToString();
            generalInvoiceInfo.adjustmentInvoiceType = "1";
            generalInvoiceInfo.adjustedNote = "Điều chỉnh tiền do cong nham";
            generalInvoiceInfo.originalInvoiceId = "K25NAF6";
            generalInvoiceInfo.originalInvoiceIssueDate = "1736926518000";
            generalInvoiceInfo.originalTemplateCode = "6/1103";
            generalInvoiceInfo.additionalReferenceDesc = "VĂN BAN THOA THUAN";
            generalInvoiceInfo.additionalReferenceDate = 1605682860000l;
            invoiceWSDTO.generalInvoiceInfo = generalInvoiceInfo;

            // Thong tin nguoi mua
            InvoiceInputWSDTO.buyerInfo buyerInfo = new InvoiceInputWSDTO.buyerInfo();
            buyerInfo.buyerName = "Nguyen Van An";
            buyerInfo.buyerLegalName = "Cong Ty TNHH ABC";
            buyerInfo.buyerTaxCode = "0100109106-990";
            buyerInfo.buyerAddressLine = "Duong Le Trong Tan, Ha Dong";
            buyerInfo.buyerPhoneNumber = "0912345678";
            buyerInfo.buyerEmail = "abc@gmail.com";
            buyerInfo.buyerIdNo = "030081002099";
            buyerInfo.buyerIdType = "1";
            buyerInfo.buyerCode = "NO_CODE";
            buyerInfo.buyerBankName = "Ngan Hang TMCP XYZ";
            buyerInfo.buyerBankAccount = "000193651773658";
            buyerInfo.buyerNotGetInvoice = 1;
            invoiceWSDTO.buyerInfo = buyerInfo;

            // Hinh thuc thanh toan: Truyền giá trị theo đúng hình thức của hóa đơn
            InvoiceInputWSDTO.PaymentInfo paymentInfo = new InvoiceInputWSDTO.PaymentInfo();
            paymentInfo.paymentMethodName = "TM/CK";
            invoiceWSDTO.payments = new List<InvoiceInputWSDTO.PaymentInfo> { paymentInfo };

            // Thong tin hang hoa: Thêm danh sách hàng hóa tương ứng
            List<InvoiceInputWSDTO.ItemInfo> list = new List<InvoiceInputWSDTO.ItemInfo>();
            InvoiceInputWSDTO.ItemInfo itemInfo = new InvoiceInputWSDTO.ItemInfo();
            itemInfo.itemCode = "HH001";
            itemInfo.itemName = "May tinh";
            itemInfo.unitName = "Chiec";
            itemInfo.itemNote = "Chi chu hang hoa";
            itemInfo.unitPrice = new decimal(15000000);
            itemInfo.quantity = new decimal(2);
            itemInfo.itemTotalAmountWithoutTax = new decimal(30000000);
            itemInfo.itemTotalAmountWithTax = new decimal(30000000);
            itemInfo.itemTotalAmountAfterDiscount = new decimal(0);
            itemInfo.discount = new decimal(0);
            itemInfo.discount2 = new decimal(0);
            itemInfo.itemDiscount = new decimal(0);
            itemInfo.selection = 1;
            list.Add(itemInfo);
            invoiceWSDTO.itemInfo = list;


            //Thong tin bo sung:
            // - Nếu không có thông tin bổ sung thì bỏ qua
            // - Nếu có thì thêm theo các thông tin bổ sung của mẫu hóa đơn
            List<InvoiceInputWSDTO.MetaDataInfo> infoUpdateList = new List<InvoiceInputWSDTO.MetaDataInfo>();
            InvoiceInputWSDTO.MetaDataInfo info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Lệnh điều động nội bộ";
            info.keyTag = "economicContractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Tên người vận chuyển";
            info.keyTag = "transformer";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Phương tiện vận chuyển";
            info.keyTag = "vehicle";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Hợp đồng số (Hợp đồng vận chuyển)";
            info.keyTag = "contractNo";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Họ và tên người xuất hàng";
            info.keyTag = "exporterName";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Xuất tại kho";
            info.keyTag = "exportAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Nhập tại kho";
            info.keyTag = "importAt";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Về việc";
            info.keyTag = "commandDes";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Ngày tháng năm lệnh điều động";
            info.keyTag = "commandDate";
            info.valueType = "text";
            infoUpdateList.Add(info);
            info = new InvoiceInputWSDTO.MetaDataInfo();
            info.stringValue = "Của";
            info.keyTag = "cua";
            info.valueType = "text";
            infoUpdateList.Add(info);
            invoiceWSDTO.metadata = infoUpdateList;

            // Tong tien hoa don
            InvoiceInputWSDTO.SummarizeInfo sum = new InvoiceInputWSDTO.SummarizeInfo();
            sum.discountAmount = new decimal(0);
            sum.totalAmountWithoutTax = new decimal(30000000);
            sum.totalAmountWithTax = new decimal(30000000);
            sum.totalAmountAfterDiscount = new decimal(30000000);
            invoiceWSDTO.summarizeInfo = sum;

            return invoiceWSDTO;
        }

        //private HttpRequestMessage GeneratePostRequest(string token, object request)
        //{
        //    var requestMessage = new HttpRequestMessage(HttpMethod.Post, "");
        //    requestMessage.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("*/*"));
        //    requestMessage.Content = new StringContent(JsonConvert.SerializeObject(request));
        //    requestMessage.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

        //    if (!string.IsNullOrEmpty(token))
        //    {
        //        requestMessage.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        //    }

        //    return requestMessage;
        //}

        //private async Task<object> PostDataAsync(string url, string token, object bodyObject, Type valueTypeRef)
        //{
        //    try
        //    {
        //        using (var httpClient = new HttpClient())
        //        {
        //            var request = GeneratePostRequest(token, bodyObject);
        //            var response = await httpClient.SendAsync(request);

        //            if (response.IsSuccessStatusCode)
        //            {
        //                var json = await response.Content.ReadAsStringAsync();
        //                return JsonConvert.DeserializeObject(json, valueTypeRef);
        //            }
        //            else
        //            {
        //                return null;
        //            }
        //        }
        //    }
        //    catch (Exception ex)
        //    {
        //        Console.Error.WriteLine(ex.Message);
        //        if (!string.IsNullOrEmpty(ex.Message) &&
        //            (ex.Message.ToLower().Contains("no route to host: connect") ||
        //             ex.Message.ToLower().Contains("i/o error")))
        //        {
        //            throw;
        //        }

        //        var json = ((HttpRequestException)ex).Message.Replace("\n", "");
        //        try
        //        {
        //            var map = JsonConvert.DeserializeObject<Dictionary<string, object>>(json);
        //            var data = JsonConvert.SerializeObject(map["data"]);
        //            return data.Replace("\"", "");
        //        }
        //        catch (Exception exception)
        //        {
        //            Console.Error.WriteLine(exception.Message);
        //            return null;
        //        }
        //    }
        //}

        //private HttpRequestMessage GenerateXFormPostRequest(string token, object request)
        //{
        //    var headers = new HttpRequestMessage();
        //    var jsonSettings = new JsonSerializerSettings
        //    {
        //        MissingMemberHandling = MissingMemberHandling.Ignore,
        //        DateFormatHandling = DateFormatHandling.IsoDateFormat
        //    };

        //    var fieldMap = JsonConvert.DeserializeObject<Dictionary<string, string>>(JsonConvert.SerializeObject(request, jsonSettings));
        //    var content = new FormUrlEncodedContent(fieldMap);

        //    headers.Content = content;
        //    headers.Content.Headers.ContentType = new MediaTypeHeaderValue("application/x-www-form-urlencoded");            
        //    if (token != null)
        //    {
        //        headers.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        //    }

        //    return headers;
        //}

        private async Task<object> PostXFormData(string url, string token, object bodyObject)
        {
            try
            {
                client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                var jsonSettings = new JsonSerializerSettings
                    {
                        MissingMemberHandling = MissingMemberHandling.Ignore,
                        DateFormatHandling = DateFormatHandling.IsoDateFormat
                    };

                    var fieldMap = JsonConvert.DeserializeObject<Dictionary<string, string>>(JsonConvert.SerializeObject(bodyObject, jsonSettings));
                    var content = new FormUrlEncodedContent(fieldMap);

                    var response = await client.PostAsync(url, content);
                    var responseString = await response.Content.ReadAsStringAsync();

                return response;

            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.Message);
                if (ex.Message != null && !string.IsNullOrEmpty(ex.Message) &&
                    (ex.Message.ToLower().Contains("No route to host: connect".ToLower()) ||
                    ex.Message.ToLower().Contains("I/O error".ToLower())))
                {
                    throw;
                }

                var json = ((HttpRequestException)ex).Message.Replace("\n", "");
                try
                {
                    var map = JsonConvert.DeserializeObject<Dictionary<string, object>>(json);
                    var data = JsonConvert.SerializeObject(map["data"]);
                    return data.Replace("\"", "");
                }
                catch (Exception exception)
                {
                    Console.Error.WriteLine(exception.Message);
                    return null;
                }
            }
        }
    }
}
