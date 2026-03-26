using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Runtime.Serialization;
using System.Xml.Serialization;

namespace ExampleCreateInvoice
{
    [XmlRoot("InvoiceInputWSDTO")]
    public class InvoiceInputWSDTO : ISerializable
    {
        public void GetObjectData(SerializationInfo info, StreamingContext context)
        {
            throw new NotImplementedException();
        }

        public class BaseDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_NO_REQUIRED")]
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_LENGTH")]
            [RegularExpression("^[a-zA-Z0-9/-]*$", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public string invoiceNo { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public string templateCode { get; set; }

            public BaseDTO()
            {
            }
        }

        [XmlRoot("getInvoiceInput")]
        public class GetInvoiceInput
        {
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_LENGTH")]
            [RegularExpression("^[a-zA-Z0-9/-]*$", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public string invoiceNo { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_START_DATE_REQUIRED")]
            [StringLength(50, ErrorMessage = "BAD_REQUEST_START_DATE_MAX_LENGTH")]
            public string startDate { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_END_DATE_REQUIRED")]
            [StringLength(50, ErrorMessage = "BAD_REQUEST_END_DATE_MAX_LENGTH")]
            public string endDate { get; set; }
            public string invoiceType { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ROW_PER_PAGE_REQUIRED")]
            [Range(1, int.MaxValue, ErrorMessage = "BAD_REQUEST_ROW_PER_PAGE_MIN_VALUE")]
            public int? rowPerPage { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_PAGE_NUM_REQUIRED")]
            [Range(0, int.MaxValue, ErrorMessage = "BAD_REQUEST_PAGE_NUM_MIN_VALUE")]
            public int? pageNum { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_BUYER_TAX_CODE_MAX_LENGTH")]
            public string buyerTaxCode { get; set; } // Long
            public string buyerIdNo { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public string templateCode { get; set; }

            [StringLength(9, ErrorMessage = "BAD_REQUEST_INVOICE_SERIAL_MAX_LENGTH")]
            public string invoiceSeri { get; set; }

            public bool? getAll { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_ISSUE_START_DATE_MAX_LENGTH")]
            public string issueStartDate { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_ISSUE_END_DATE_MAX_LENGTH")]
            public string issueEndDate { get; set; }

            public GetInvoiceInput()
            {
            }
        }
        public  class CancelTransactionWSDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public  string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_NO_REQUIRED")]
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_LENGTH")]
            [RegularExpression("^[a-zA-Z0-9/-]*$", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public  string invoiceNo { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public  string templateCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ISSUE_DATE_REQUIRED")]
            public  long strIssueDate { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ADDITIONAL_REFER_DESC_REQUIRED")]
            [StringLength(400, ErrorMessage = "BAD_REQUEST_ADDITIONAL_REFER_DESC_LENGTH")]
            public  string additionalReferenceDesc { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ADDITIONAL_REFER_DATE_REQUIRED")]
            public  long additionalReferenceDate { get; set; }

            [StringLength(255, ErrorMessage = "BAD_REQUEST_REASON_DELETE_LENGTH")]
            public  string reasonDelete { get; set; }

        }

        [XmlRoot("commonDataInput")]
        public class CommonDataInput
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ISSUE_DATE_REQUIRED")]
            public string strIssueDate { get; set; }

            public CommonDataInput()
            {
            }
        }

        [XmlRoot("commonDataInput2")]
        public class CommonDataInput2
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public string templateCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_SERIAL_REQUIRED")]
            [StringLength(9, ErrorMessage = "BAD_REQUEST_INVOICE_SERIAL_MAX_LENGTH")]
            public string serial { get; set; }

            public CommonDataInput2()
            {
            }
        }
        [XmlRoot("commonDataInput3")]
        public class CommonDataInput3
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_FROM_DATE_REQUIRED")]           
            public string fromDate { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_TO_DATE_REQUIRED")]
            public string toDate { get; set; }

            public CommonDataInput3()
            {
            }
        }
        [XmlRoot("commonDataInput4")]
        public class CommonDataInput4
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_LST_TRANSACTION_UUID_REQUIRED")]
            public string lstTransactionUuid { get; set; }

            public CommonDataInput4()
            {
            }
        }

        public  class UpdatePaymentWSDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public  string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_NO_REQUIRED")]
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_MAX_LENGTH")]
            [RegularExpression("^[a-zA-Z0-9/-]*$", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public  string invoiceNo { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public  string templateCode { get; set; }
            public  long strIssueDate { get; set; }

            [StringLength(2000, ErrorMessage = "BAD_REQUEST_BUYER_EMAIL_MAX_LENGTH")]
            public  string buyerEmailAddress { get; set; }

            public  string paymentType { get; set; }
            public  string paymentTypeName { get; set; }

        }

        public  class CancelPaymentWSDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public  string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_NO_REQUIRED")]
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_MAX_LENGTH")]
            [RegularExpression("^[a-zA-Z0-9/-]*$", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public  string invoiceNo { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ISSUE_DATE_REQUIRED")]
            public  long strIssueDate { get; set; }

        }

        [XmlRoot("commonInvoiceInput")]
        public class CreateInvoiceWSDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_GENERAL_INVOICE_INFO_REQUIRED")]
            public GeneralInvoiceInfo generalInvoiceInfo { get; set; }

            public sellerInfo sellerInfo { get; set; }
            public buyerInfo buyerInfo { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_PAYMENT_INFO_REQUIRED")]
            [MinLength(1, ErrorMessage = "BAD_REQUEST_PAYMENT_INFO_REQUIRED")]
            public List<PaymentInfo> payments { get; set; }

            public List<ItemInfo> itemInfo { get; set; }
            public List<TaxBreakDownsInfo> taxBreakdowns { get; set; }
            public SummarizeInfo summarizeInfo { get; set; }
            public List<MetaDataInfo> metadata { get; set; }
            public List<MeterReadingInfo> meterReading { get; set; }
            public List<FuelReadingInfo> fuelReading { get; set; }

            public QrCodeInfo qrCodeInfo { get; set; }

            public CreateInvoiceWSDTO()
            {
            }
        }

        public class GeneralInvoiceInfo
        {
            public string invoiceType { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public string templateCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_SERIAL_REQUIRED")]
            [StringLength(9, ErrorMessage = "BAD_REQUEST_INVOICE_SERIAL_MAX_LENGTH")]
            public string invoiceSeries { get; set; }

            public long? invoiceIssuedDate { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_CURRENCY_CODE_REQUIRED")]
            [StringLength(3, MinimumLength = 3, ErrorMessage = "BAD_REQUEST_CURRENCY_CODE_MINLENGTH")]
            [RegularExpression("[A-Z]+", ErrorMessage = "BAD_REQUEST_CURRENCY_CODE_INVALID")]
            public string currencyCode { get; set; }

            [RegularExpression("^$|[1,3,5,7]", ErrorMessage = "BAD_REQUEST_ADJUSTMENT_TYPE_INVALID")]
            [StringLength(1, ErrorMessage = "BAD_REQUEST_ADJUSTMENT_TYPE_MAX_LENGTH")]
            public string adjustmentType { get; set; }

            [StringLength(1, ErrorMessage = "BAD_REQUEST_ADJUSTMENT_INVOICE_TYPE_MAX_LENGTH")]
            [RegularExpression("^$|[1,2]", ErrorMessage = "BAD_REQUEST_ADJUSTMENT_INVOICE_TYPE_INVALID")]
            public string adjustmentInvoiceType { get; set; }

            [StringLength(17, MinimumLength = 1, ErrorMessage = "BAD_REQUEST_ORIGIN_INVOICE_NO_INVALID_LENGTH")]
            [RegularExpression("^[a-zA-Z0-9/-]*$", ErrorMessage = "BAD_REQUEST_ORIGIN_INVOICE_NO_INVALID")]
            public string originalInvoiceId { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_ORIGIN_INVOICE_ISSUE_DATE_INVALID")]
            public string originalInvoiceIssueDate { get; set; } // yyyy-MM-dd

            [StringLength(400, ErrorMessage = "BAD_REQUEST_ADDITIONAL_REFER_DESC_LENGTH")]
            public string additionalReferenceDesc { get; set; }

            public long? additionalReferenceDate { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_PAYMENT_STATUS_REQUIRED")]
            public bool? paymentStatus { get; set; } // max length 1, boolean

            [Range(0, 99999999999.99, ErrorMessage = "BAD_REQUEST_EXCHANGE_RATE_MAX_LENGTH")]
            public decimal? exchangeRate { get; set; } // maxlength 13

            [StringLength(36, MinimumLength = 10, ErrorMessage = "BAD_REQUEST_TRANSACTION_UUID_LENGTH_INVALID")]
            public string transactionUuid { get; set; }

            public string userName { get; set; }

            [StringLength(100, ErrorMessage = "BAD_REQUEST_CERTIFICATE_SERIAL_MAX_LENGTH")]
            public string certificateSerial { get; set; }

            public string transactionId { get; set; }

            [StringLength(4000, ErrorMessage = "BAD_REQUEST_INVOICE_NOTE_LENGTH_INVALID")]
            public string invoiceNote { get; set; }

            [StringLength(1, ErrorMessage = "BAD_REQUEST_ADJUST_AMOUNT20_MAX_LENGTH")]
            [RegularExpression("^$|[0,1,2,3,5]", ErrorMessage = "BAD_REQUEST_ADJUST_AMOUNT20_INVALID")]
            public string adjustAmount20 { get; set; }

            [StringLength(1, ErrorMessage = "BAD_REQUEST_ORIGINAL_INVOICE_TYPE_MAX_LENGTH")]
            [RegularExpression("^$|[0,1,2,3,4]", ErrorMessage = "BAD_REQUEST_ORIGINAL_INVOICE_TYPE_INVALID")]
            public string originalinvoiceType { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_ORIGINAL_TEMPLATE_CODE_MAX_LENGTH")]
            public string originalTemplateCode { get; set; }

            [StringLength(255, ErrorMessage = "BAD_REQUEST_ADJUSTED_NOTE_MAX_LENGTH")]
            public string adjustedNote { get; set; }

            [StringLength(100, ErrorMessage = "BAD_REQUEST_RESERVATION_CODE_MAX_LENGTH")]
            public string reservationCode { get; set; }

            public int validation { get; set; }

            public long? typeId { get; set; }
            public long? classifyId { get; set; }

            public override string ToString()
            {
                return "GeneralInvoiceInfo{" +
                    "invoiceType='" + invoiceType + '\'' +
                    ", templateCode='" + templateCode + '\'' +
                    ", invoiceSeries='" + invoiceSeries + '\'' +
                    ", invoiceIssuedDate=" + invoiceIssuedDate +
                    ", currencyCode='" + currencyCode + '\'' +
                    ", adjustmentType='" + adjustmentType + '\'' +
                    ", adjustmentinvoiceType='" + adjustmentInvoiceType + '\'' +
                    ", originalInvoiceId='" + originalInvoiceId + '\'' +
                    ", originalInvoiceIssueDate='" + originalInvoiceIssueDate + '\'' +
                    ", additionalReferenceDesc='" + additionalReferenceDesc + '\'' +
                    ", additionalReferenceDate=" + additionalReferenceDate +
                    ", paymentStatus=" + paymentStatus +
                    ", exchangeRate=" + exchangeRate +
                    ", transactionUuid='" + transactionUuid + '\'' +
                    ", userName='" + userName + '\'' +
                    ", certificateSerial='" + certificateSerial + '\'' +
                    ", transactionId='" + transactionId + '\'' +
                    ", invoiceNote='" + invoiceNote + '\'' +
                    ", validation='" + validation + '\'' +
                    '}';
            }
        }

        public class sellerInfo
        {
            [StringLength(255, ErrorMessage = "BAD_REQUEST_SELLER_LEGAL_NAME_MAXLENGTH")]
            public string sellerLegalName { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_SELLER_TAX_CODE_MAX_LENGTH")]
            public string sellerTaxCode { get; set; }

            [StringLength(255, ErrorMessage = "BAD_REQUEST_SELLER_ADDRESS_LINE_MAXLENGTH")]
            public string sellerAddressLine { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_SELLER_PHONE_NUMBER_MAX_LENGTH")]
            [RegularExpression(@"^\s*[0-9]*\s*$", ErrorMessage = "BAD_REQUEST_SELLER_PHONE_NUMBER_INVALID")]
            public string sellerPhoneNumber { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_SELLER_FAX_NUMBER_MAXLENGTH")]
            [RegularExpression(@"^\s*[0-9]*\s*$", ErrorMessage = "BAD_REQUEST_SELLER_FAX_NUMBER_INVALID")]
            public string sellerFaxNumber { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_SELLER_EMAIL_MAX_LENGTH")]
            public string sellerEmail { get; set; }

            [StringLength(400, ErrorMessage = "BAD_REQUEST_SELLER_BANK_NAME_MAXLENGTH")]
            public string sellerBankName { get; set; }

            [StringLength(200, ErrorMessage = "BAD_REQUEST_SELLER_BANK_ACCOUNT_MAXLENGTH")]
            public string sellerBankAccount { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_SELLER_DISTRICT_NAME_MAX_LENGTH")]
            public string sellerDistrictName { get; set; }

            [StringLength(600, ErrorMessage = "BAD_REQUEST_SELLER_CITY_NAME_MAX_LENGTH")]
            public string sellerCityName { get; set; }

            [StringLength(17, ErrorMessage = "BAD_REQUEST_SELLER_COUNTRY_CODE_MAX_LENGTH")]
            public string sellerCountryCode { get; set; }

            [StringLength(200, ErrorMessage = "BAD_REQUEST_WEBSITE_MAX_LENGTH")]
            public string sellerWebsite { get; set; }

            public string merchantCode { get; set; }

            public string merchantName { get; set; }

            public string merchantCity { get; set; }

            public sellerInfo()
            {
            }

            public override string ToString()
            {
                return "sellerInfo{" +
                "sellerLegalName='" + sellerLegalName +
                ", sellerTaxCode='" + sellerTaxCode +
                ", sellerAddressLine='" + sellerAddressLine +
                ", sellerPhoneNumber='" + sellerPhoneNumber +
                ", sellerFaxNumber='" + sellerFaxNumber +
                ", sellerEmail='" + sellerEmail +
                ", sellerBankName='" + sellerBankName +
                ", sellerBankAccount='" + sellerBankAccount +
                ", sellerDistrictName='" + sellerDistrictName +
                ", sellerCityName='" + sellerCityName +
                ", sellerCountryCode='" + sellerCountryCode +
                ", sellerWebsite='" + sellerWebsite +
                ", merchantCode='" + merchantCode +
                ", merchantName='" + merchantName +
                ", merchantCity='" + merchantCity +
                '}';
            }
        }
        public  class buyerInfo
        {
            [StringLength(800, ErrorMessage = "BAD_REQUEST_BUYER_NAME_MAXLENGTH")]
            public string buyerName { get; set; }

            [StringLength(400, ErrorMessage = "BAD_REQUEST_BUYER_CODE_MAX_LENGTH")]
            public string buyerCode { get; set; }

            [StringLength(1200, ErrorMessage = "BAD_REQUEST_BUYER_UNIT_NAME_MAX_LENGTH")]
            public string buyerLegalName { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_BUYER_TAX_CODE_MAX_LENGTH")]
            public string buyerTaxCode { get; set; }

            [StringLength(1200, ErrorMessage = "BAD_REQUEST_BUYER_ADDRESS_MAX_LENGTH")]
            public string buyerAddressLine { get; set; }

            [StringLength(35, ErrorMessage = "BAD_REQUEST_BUYER_PHONE_MAX_LENGTH")]
            [RegularExpression("[0-9+()&; -]*", ErrorMessage = "BAD_REQUEST_BUYER_PHONE_INVALID")]
            public string buyerPhoneNumber { get; set; }

            // Hệ thống không check
            public string buyerFaxNumber { get; set; }

            // Được phép nhập nhiều email, mỗi email cách nhau bởi dấu ;
            [StringLength(2000, ErrorMessage = "BAD_REQUEST_BUYER_EMAIL_MAX_LENGTH")]
            public string buyerEmail { get; set; }

            [StringLength(200, ErrorMessage = "BAD_REQUEST_BUYER_BANK_NAME_MAX_LENGTH")]
            public string buyerBankName { get; set; }

            [StringLength(100, ErrorMessage = "BAD_REQUEST_BUYER_BANK_ACCOUNT_MAX_LENGTH")]
            public string buyerBankAccount { get; set; }
            public string buyerIdType { get; set; }

            [StringLength(200, ErrorMessage = "BAD_REQUEST_BUYER_ID_NO_MAX_LENGTH")]
            [RegularExpression("[a-zA-Z0-9-_ ]*", ErrorMessage = "BAD_REQUEST_BUYER_ID_NO_INVALID")]
            public string buyerIdNo { get; set; }

            public int? buyerNotGetInvoice { get; set; }

            public buyerInfo()
            {
            }
            public override string ToString()
            {
                return "buyerInfo{" +
                "buyerName='" + buyerName +
                ", buyerCode='" + buyerCode +
                ", buyerLegalName='" + buyerLegalName +
                ", buyerTaxCode='" + buyerTaxCode +
                ", buyerAddressLine='" + buyerAddressLine +
                ", buyerPhoneNumber='" + buyerPhoneNumber +
                ", buyerFaxNumber='" + buyerFaxNumber +
                ", buyerEmail='" + buyerEmail +
                ", buyerBankName='" + buyerBankName +
                ", buyerBankAccount='" + buyerBankAccount +
                ", buyerIdType='" + buyerIdType +
                ", buyerIdNo='" + buyerIdNo +
                ", buyerNotGetInvoice=" + buyerNotGetInvoice +
                '}';
            }
        }

        public  class PaymentInfo
        {
            [StringLength(50, ErrorMessage = "BAD_REQUEST_PAYMENT_METHOD_NAME_MAX_LENGTH")]
            public string paymentMethodName { get; set; }

            [RegularExpression("\\s*|[1-8]$", ErrorMessage = "BAD_REQUEST_PAYMENT_METHOD_INVALID")]
            [StringLength(50, ErrorMessage = "BAD_REQUEST_PAYMENT_METHOD_MAX_LENGTH")]
            public string paymentMethod { get; set; }

            public PaymentInfo()
            {
            }
            public override string ToString()
            {
                return "PaymentInfo{" +
               "paymentMethodName='" + paymentMethodName +
               ", paymentMethod='" + paymentMethod +
               '}';
            }
        }

        public  class ItemInfo
        {
            [Range(1, 6, ErrorMessage = "BAD_REQUEST_ITEM_SELECTION_INVALID")]
            public int? selection { get; set; } // maxlength 1

            public string itemCode { get; set; }

            public string itemName { get; set; }

            public string unitCode { get; set; }

            public string unitName { get; set; }
            public decimal? unitPrice { get; set; }
            public decimal? quantity { get; set; }

            [RegularExpression(@"^\d{1,19}(\.\d{1,9})?$", ErrorMessage = "BAD_REQUEST_ITEM_TOTAL_AMOUNT_WITHOUT_TAX_INVALID")]
            public decimal? itemTotalAmountWithoutTax { get; set; }

            public decimal? taxPercentage { get; set; }

            public decimal? taxAmount { get; set; }

            public bool? isIncreaseItem { get; set; }

            public string itemNote { get; set; }

            public string batchNo { get; set; }

            public string expDate { get; set; } // Date

            public decimal? discount { get; set; }

            public decimal? discount2 { get; set; }

            public decimal? itemDiscount { get; set; }

            public decimal? itemTotalAmountAfterDiscount { get; set; }

            public decimal? itemTotalAmountWithTax { get; set; }

            [StringLength(1, ErrorMessage = "BAD_REQUEST_ADJUST_RATIO_MAX_LENGTH")]
            [RegularExpression(@"^$|[1,2,3,5]", ErrorMessage = "BAD_REQUEST_ADJUST_RATIO_INVALID")]
            public string adjustRatio { get; set; }

            public ItemInfo()
            {
            }
        }

        public  class TaxBreakDownsInfo
        {
            public decimal? taxPercentage { get; set; } // maxlength 13

            public decimal? taxableAmount { get; set; } // maxlength 13

            public decimal? taxAmount { get; set; } // maxlength 13

            public TaxBreakDownsInfo()
            {
            }
        }

        public  class SummarizeInfo
        {
            public decimal? totalAmountWithoutTax { get; set; } // maxlength 15
            public decimal? totalTaxAmount { get; set; } // maxlength 13
            public decimal? totalAmountWithTax { get; set; } // maxlength 13
            public decimal? totalAmountWithTaxFrn { get; set; } // maxlength 13

            public string totalAmountWithTaxInWords { get; set; }
            public decimal? discountAmount { get; set; } // maxlength 13
            public decimal? settlementDiscountAmount { get; set; } // maxlength 13

            [RegularExpression(@"^\d{1,19}(\.\d{1,9})?$", ErrorMessage = "BAD_REQUEST_TOTAL_AMOUNT_AFTER_DISCOUNT_INVALID")]
            public decimal? totalAmountAfterDiscount { get; set; }

            [RegularExpression(@"^\d{1,19}(\.\d{1,9})?$", ErrorMessage = "BAD_REQUEST_TOTAL_AMOUNT_AFTER_DISCOUNT_INVALID")]
            public decimal? totalAmountBeforeDiscount { get; set; }

            public SummarizeInfo()
            {
            }
        }

        public  class MetaDataInfo
        {
            public string keyTag { get; set; }
            public string valueType { get; set; } // text: 1, number: 2, date: 3
            public long? dateValue { get; set; } // Date

            [StringLength(13, ErrorMessage = "BAD_REQUEST_STRING_VALUE_MAX")]
            public string stringValue { get; set; }

            [StringLength(6, ErrorMessage = "BAD_REQUEST_NUMBER_VALUE_MAX")]
            public long? numberValue { get; set; } // maxlength 6
            public string keyLabel { get; set; }

            public bool? isRequired { get; set; } // boolean

            public bool? isSeller { get; set; } // boolean

            public MetaDataInfo()
            {
            }
        }

        public  class FuelReadingInfo
        {
            [StringLength(50, ErrorMessage = "BAD_REQUEST_ID_LOG_MAX_LENGTH")]
            public string idLog { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_PUMP_CODE_MAX_LENGTH")]
            public string pumpCode { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_PUMP_NAME_MAX_LENGTH")]
            public string pumpName { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_PRODUCT_CODE_MAX_LENGTH")]
            public string productCode { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_PRODUCT_NAME_MAX_LENGTH")]
            public string productName { get; set; }

            public decimal? qtyLog { get; set; }

            public decimal? priceLog { get; set; }

            public decimal? thanhTienLog { get; set; }

            public long? startDate { get; set; }

            public long? endDate { get; set; }

            [StringLength(50, ErrorMessage = "BAD_REQUEST_BATCH_MAX_LENGTH")]
            public string batch { get; set; }

            [StringLength(100, ErrorMessage = "BAD_REQUEST_NOTE_LOG_MAX_LENGTH")]
            public string noteLog { get; set; }

            public FuelReadingInfo()
            {
            }
        }

        public  class MeterReadingInfo
        {
            public string previousIndex { get; set; }

            public string currentIndex { get; set; }

            public string factor { get; set; }

            public string amount { get; set; } // (currentIndex - previousIndex) * factor

            public string meterName { get; set; }

            public MeterReadingInfo()
            {
            }
        }

        public  class InvoiceFileInfo
        {
            public string fileContent;

            public double? fileType; // double

            public string fileExtension;

            public InvoiceFileInfo()
            {
            }
        }

        public  class ConvertFontDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_CONVERT_FONT_REQUIRED")]
            [StringLength(255, ErrorMessage = "BAD_REQUEST_CONVERT_FONT_REQUIRED")]
            public string font;

            [Required(ErrorMessage = "BAD_REQUEST_CONVERT_FONT_DATA_REQUIRED")]
            [StringLength(255, ErrorMessage = "BAD_REQUEST_CONVERT_FONT_DATA_REQUIRED")]
            public string data;

            public ConvertFontDTO()
            {
            }
        }

        public  class CreateExchangeInvoiceFileWSDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_NO_REQUIRED")]
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_MIN_LENGTH")]
            [RegularExpression("^[a-zA-Z0-9/-]*$", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public string invoiceNo { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public string templateCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ISSUE_DATE_REQUIRED")]
            public long? strIssueDate { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_EXCHANGE_USER_REQUIRED")]
            [StringLength(100, ErrorMessage = "BAD_REQUEST_EXCHANGE_USER_MAX_LENGTH")]
            public string exchangeUser { get; set; }

            public CreateExchangeInvoiceFileWSDTO()
            {
            }
        }

        [XmlRoot("getInvoiceFilePortalDTO")]
        public  class GetInvoiceFilePortalDTO : BaseDTO
        {
            [StringLength(100, ErrorMessage = "BAD_REQUEST_BUYER_ID_NO_MAX_LENGTH_100")]
            public string buyerIdNo { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_RESERVATION_CODE_REQUIRED")]
            [StringLength(100, ErrorMessage = "BAD_REQUEST_RESERVATION_CODE_MAX_LENGTH")]
            public string reservationCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_FILE_TYPE_REQUIRED")]
            [StringLength(100, ErrorMessage = "BAD_REQUEST_FILE_TYPE_LENGTH_INVALID_100")]
            public string fileType { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ISSUE_DATE_REQUIRED")]
            public long? strIssueDate { get; set; }

            public GetInvoiceFilePortalDTO()
            {
            }
        }

        [XmlRoot("commonDataInput")]
        public  class GetInvoiceRepreDTO : BaseDTO
        {
            [StringLength(36, MinimumLength = 10, ErrorMessage = "BAD_REQUEST_TRANSACTION_UUID_LENGTH_INVALID")]
            public string transactionUuid { get; set; }

            [StringLength(3, ErrorMessage = "BAD_REQUEST_FILE_TYPE_LENGTH_INVALID")]
            public string fileType { get; set; }

            public bool? paid { get; set; }

            public string pattern { get; set; }

            public GetInvoiceRepreDTO()
            {
            }
        }

        public  class SearchByTransUUIDDTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_TRANSACTION_UUID_REQUIRED")]
            [StringLength(36, MinimumLength = 10, ErrorMessage = "BAD_REQUEST_TRANSACTION_UUID_LENGTH_INVALID")]
            public string transactionUuid { get; set; }

            public SearchByTransUUIDDTO()
            {
            }
        }

        public  class AfterSignInvoiceUSB
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public string templateCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_HAS_STRING_REQUIRED")]
            public string hashString { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_SIGNATURE_VALUE_REQUIRED")]
            public string signature { get; set; }

            public AfterSignInvoiceUSB()
            {
            }
        }

        [XmlRoot("listCommonInvoiceInput")]
        public  class CreateMultiInvoice
        {
            public List<CreateInvoiceWSDTO> CommonInvoiceInputs { get; set; }

            public List<CreateInvoiceWSDTO> GetCommonInvoiceInputs()
            {
                return CommonInvoiceInputs;
            }

            public void SetCommonInvoiceInputs(List<CreateInvoiceWSDTO> commonInvoiceInputs)
            {
                CommonInvoiceInputs = commonInvoiceInputs;
            }
        }

        public class QrCodeInfo
        {
            [Required]
            [Range(0, 99, ErrorMessage = "BAD_REQUEST_TOTAL_SCAN_MIN")]
            public int? totalScan { get; set; }

            [Required]
            [Range(0, 99, ErrorMessage = "BAD_REQUEST_REMAIN_SCAN_MIN")]
            public int? remainScan { get; set; }

            [Required]
            public long? startDateQrcode { get; set; }

            [Required]
            public long? endDateQrcode { get; set; }

            [StringLength(200, ErrorMessage = "BAD_REQUEST_TEMPOS_TYPE_OVER_LENGTH")]
            public string temposType { get; set; }

            public override string ToString()
            {
                return $"QrCodeInfo{{ totalScan={totalScan}, remainScan={remainScan}, startDateQrcode={startDateQrcode}, endDateQrcode={endDateQrcode} }}";
            }
        }

        public class QrCodeInfoDto
        {
            [Required]
            public string taxCode { get; set; }

            [Required]
            public string templateCode { get; set; }

            [Required]
            public string invoiceNo { get; set; }

            [Range(0, 1, ErrorMessage = "BAD_REQUEST_PRINT_STATUS_VALUE")]
            public int? printStatus { get; set; }
        }
        public  class CreateExchangeInvoiceFileWSV1DTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_NO_REQUIRED")]
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_MIN_LENGTH")]
            [RegularExpression(@"([a-zA-Z0-9/-]+|( [a-zA-Z0-9]*$))", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public string invoiceNo { get; set; }

            [StringLength(20, ErrorMessage = "BAD_REQUEST_TEMPLATE_CODE_MAX_LENGTH")]
            public string templateCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ISSUE_DATE_REQUIRED")]
            public string strIssueDate { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_EXCHANGE_USER_REQUIRED")]
            [StringLength(100, ErrorMessage = "BAD_REQUEST_EXCHANGE_USER_MAX_LENGTH")]
            public string exchangeUser { get; set; }

            public CreateExchangeInvoiceFileWSV1DTO()
            {
            }
        }

        public  class CancelPaymentWSV1DTO
        {
            [Required(ErrorMessage = "BAD_REQUEST_TAX_CODE_REQUIRED")]
            [StringLength(20, ErrorMessage = "BAD_REQUEST_TAX_CODE_MAX_LENGTH")]
            public string supplierTaxCode { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_INVOICE_NO_REQUIRED")]
            [StringLength(17, MinimumLength = 7, ErrorMessage = "BAD_REQUEST_INVOICE_NO_MIN_LENGTH")]
            [RegularExpression(@"([a-zA-Z0-9/-]+|( [a-zA-Z0-9]*$))", ErrorMessage = "BAD_REQUEST_INVOICE_NO_INVALID")]
            public string invoiceNo { get; set; }

            [Required(ErrorMessage = "BAD_REQUEST_ISSUE_DATE_REQUIRED")]
            public string strIssueDate { get; set; }

            public CancelPaymentWSV1DTO()
            {
            }
        }

        public  class UpdateInvoiceExplanationDTO
        {
            public string supplierTaxCode { get; set; }
            public string templateCode { get; set; }
            public string invoiceNo { get; set; }
            public long? strIssueDate { get; set; }
            public string Reason { get; set; }
        }
    }
}

