using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Xml.Serialization;

namespace ExampleCreateInvoice
{
    class InvoiceOutputDTO
    {
        [Serializable]
        public class InvoicesOutput
        {
            private long invoiceId { get; set; }

            private string invoiceType { get; set; }

            private string adjustmentType { get; set; }

            private string templateCode { get; set; }

            private string invoiceSeri { get; set; }

            private string invoiceNumber { get; set; }

            private string invoiceNo { get; set; }

            private string currency { get; set; }

            private decimal total { get; set; }

            private long issueDate { get; set; }

            // json
            private string issueDateStr { get; set; }

            private int state { get; set; }

            private long requestDate { get; set; }

            private string description { get; set; }

            private string buyerIdNo { get; set; }

            private int stateCode { get; set; }

            private long subscriberNumber { get; set; }

            private int paymentStatus { get; set; }

            private int viewStatus { get; set; }

            private int downloadStatus { get; set; }

            private int exchangeStatus { get; set; }

            private int numOfExchange { get; set; }

            private long createTime { get; set; }

            private long contractId { get; set; }

            private string contractNo { get; set; }

            private string supplierTaxCode { get; set; }

            private string buyerTaxCode { get; set; }

            private decimal totalBeforeTax { get; set; }

            private decimal taxAmount { get; set; }

            private string taxRate { get; set; }

            private string paymentMethod { get; set; }

            private long paymentTime { get; set; }

            private long customerId { get; set; }

            private string no { get; set; }

            private string paymentStatusName { get; set; }

            // xml
            private string buyerName { get; set; }

            private string transactionUuid { get; set; }

            private string originalInvoiceId { get; set; }

            public InvoicesOutput() { }

            public InvoicesOutput(string adjustmentType, string buyerName, string buyerTaxCode, long createTime, string currency, long invoiceId, string invoiceNo, string invoiceNumber, string invoiceSeri, string invoiceType, long issueDate, int paymentStatus, string supplierTaxCode, decimal taxAmount, string templateCode, decimal total, decimal totalBeforeTax, int viewStatus, string issueDateStr, int state, long requestDate, string description, string buyerIdNo, int stateCode, long subscriberNumber, int downloadStatus, int exchangeStatus, int numOfExchange, long contractId, string contractNo, string taxRate, string paymentMethod, long paymentTime, long customerId, string no, string paymentStatusName, string originalInvoiceNo)
            {
                this.adjustmentType = adjustmentType;
                this.buyerName = buyerName;
                this.buyerTaxCode = buyerTaxCode;
                this.createTime = createTime;
                this.currency = currency;
                this.invoiceId = invoiceId;
                this.invoiceNo = invoiceNo;
                this.invoiceNumber = invoiceNumber;
                this.invoiceSeri = invoiceSeri;
                this.invoiceType = invoiceType;
                this.issueDate = issueDate;
                this.paymentStatus = paymentStatus;
                this.supplierTaxCode = supplierTaxCode;
                this.taxAmount = taxAmount;
                this.templateCode = templateCode;
                this.total = total;
                this.totalBeforeTax = totalBeforeTax;
                this.viewStatus = viewStatus;
                this.issueDateStr = issueDateStr;
                this.state = state;
                this.requestDate = requestDate;
                this.description = description;
                this.buyerIdNo = buyerIdNo;
                this.stateCode = stateCode;
                this.subscriberNumber = subscriberNumber;
                this.downloadStatus = downloadStatus;
                this.exchangeStatus = exchangeStatus;
                this.numOfExchange = numOfExchange;
                this.contractId = contractId;
                this.contractNo = contractNo;
                this.taxRate = taxRate;
                this.paymentMethod = paymentMethod;
                this.paymentTime = paymentTime;
                this.customerId = customerId;
                this.no = no;
                this.paymentStatusName = paymentStatusName;
                this.originalInvoiceId = originalInvoiceNo;
            }
        }

        [XmlRoot]
        public class BaseOutputDTO
        {
            private int? errorCode;
            private string description;

            public int? ErrorCode
            {
                get { return errorCode; }
                set { errorCode = value; }
            }

            public string Description
            {
                get { return description; }
                set { description = value; }
            }
        }

        [XmlRoot("getInvoiceFilePortalResp")]
        public class GetInvoiceFilePortalResp : BaseOutputDTO
        {
            private byte[] fileToBytes;
            private bool paymentStatus;
            private string fileName;

            public GetInvoiceFilePortalResp() { }

            public byte[] FileToBytes
            {
                get { return fileToBytes; }
                set { fileToBytes = value; }
            }

            public bool PaymentStatus
            {
                get { return paymentStatus; }
                set { paymentStatus = value; }
            }

            public string FileName
            {
                get { return fileName; }
                set { fileName = value; }
            }
        }

        public class UpdateTaxResp : BaseOutputDTO
        {
            private string status;
            private int record;

            public string Status
            {
                get { return status; }
                set { status = value; }
            }

            public int Record
            {
                get { return record; }
                set { record = value; }
            }
        }

        public class UpdatePaymentResp : BaseOutputDTO
        {
            private bool? result;
            private long? paymentTime;
            private string paymentMethod;

            public bool? Result
            {
                get { return result; }
                set { result = value; }
            }

            public long? PaymentTime
            {
                get { return paymentTime; }
                set { paymentTime = value; }
            }

            public string PaymentMethod
            {
                get { return paymentMethod; }
                set { paymentMethod = value; }
            }
        }

        [XmlRoot("invoicesOutput")]
        public class SearchInvoiceResp : BaseOutputDTO
        {
            public long? TotalRows { get; set; }
            public List<InvoicesOutput> Invoices { get; set; }
        }

        [XmlRoot("createInvoiceOutput")]
        public class CreateDraftResp
        {
            public string ErrorCode { get; set; }
            public string Description { get; set; }
            public EmptyResult Result { get; set; }
        }

        [JsonObject]
        public class EmptyResult
        {
        }

        public class CreateInvoiceDTO
        {
            public string SupplierTaxCode { get; set; }
            public string InvoiceNo { get; set; }
            public string TransactionID { get; set; }
            public string ReservationCode { get; set; }

            [JsonIgnore]
            public long? InvoiceId { get; set; }
            public string CodeOfTax { get; set; }
        }

        public class CreateInvoiceDTOQrCode
        {
            private string supplierTaxCode;
            private string invoiceNo;
            private string transactionID;
            private string reservationCode;
            private long? invoiceId;
            private string codeOfTax;
            private string qrCode;

            public string CodeOfTax
            {
                get { return codeOfTax; }
                set { codeOfTax = value; }
            }

            [JsonIgnore]
            public long? InvoiceId
            {
                get { return invoiceId; }
                set { invoiceId = value; }
            }

            public string SupplierTaxCode
            {
                get { return supplierTaxCode; }
                set { supplierTaxCode = value; }
            }

            public string InvoiceNo
            {
                get { return invoiceNo; }
                set { invoiceNo = value; }
            }

            public string TransactionID
            {
                get { return transactionID; }
                set { transactionID = value; }
            }

            public string ReservationCode
            {
                get { return reservationCode; }
                set { reservationCode = value; }
            }

            public string QrCode
            {
                get { return qrCode; }
                set { qrCode = value; }
            }
        }

        public  class CreateMultiInvoiceDTO
        {
            private List<CreateMultiInvoiceDTOInner> createInvoiceOutputs;
            private List<Dictionary<string, string>> lstMapError;
            private long? totalSuccess;
            private long? totalFail;

            public List<Dictionary<string, string>> LstMapError
            {
                get { return lstMapError; }
                set { lstMapError = value; }
            }

            public long? TotalSuccess
            {
                get { return totalSuccess; }
                set { totalSuccess = value; }
            }

            public long? TotalFail
            {
                get { return totalFail; }
                set { totalFail = value; }
            }

            public List<CreateMultiInvoiceDTOInner> CreateInvoiceOutputs
            {
                get { return createInvoiceOutputs; }
                set { createInvoiceOutputs = value; }
            }

            public  class CreateMultiInvoiceDTOInner
            {
                private string transactionUuid;
                private int? errorCode;
                private string description;
                private CreateInvoiceDTO result;

                public CreateMultiInvoiceDTOInner() { }

                public string TransactionUuid
                {
                    get { return transactionUuid; }
                    set { transactionUuid = value; }
                }

                public int? ErrorCode
                {
                    get { return errorCode; }
                    set { errorCode = value; }
                }

                public string Description
                {
                    get { return description; }
                    set { description = value; }
                }

                public CreateInvoiceDTO Result
                {
                    get { return result; }
                    set { result = value; }
                }
            }

            [XmlRoot("createInvoiceOutput")]
            public  class CreateInvoiceResp : BaseOutputDTO
            {
                private CreateInvoiceDTO result;

                public CreateInvoiceDTO Result
                {
                    get { return result; }
                    set { result = value; }
                }
            }

            [XmlRoot("createInvoiceQrCodeOutput")]
            public  class CreateInvoiceQRResp : BaseOutputDTO
            {
                private CreateInvoiceDTOQrCode result;

                public CreateInvoiceDTOQrCode Result
                {
                    get { return result; }
                    set { result = value; }
                }
            }

            public  class CustomFieldDTO
            {
                private long? id;
                private long? invoiceTemplatePrototypeId;
                private string keyTag;
                private string valueType;
                private string keyLabel;

                [JsonProperty("isRequired")]
                [XmlElement("isRequired")]
                private bool? isRequired;

                [JsonProperty("isSeller")]
                [XmlElement("isSeller")]
                private bool? isSeller;

                public CustomFieldDTO() { }

                public CustomFieldDTO(string keyTag, string valueType, string keyLabel, bool? isRequired, bool? isSeller, long? invoiceTemplatePrototypeId)
                {
                    this.keyLabel = keyLabel;
                    this.keyTag = keyTag;
                    this.valueType = valueType;
                    this.isRequired = isRequired;
                    this.isSeller = isSeller;
                    this.invoiceTemplatePrototypeId = invoiceTemplatePrototypeId;

                    if (valueType != null)
                    {
                        if (valueType.Trim() == "1")
                        {
                            this.valueType = "text";
                        }
                        if (valueType.Trim() == "2")
                        {
                            this.valueType = "number";
                        }
                        if (valueType.Trim() == "3")
                        {
                            this.valueType = "date";
                        }
                    }
                }
            }
            public class CustomFieldsResp : BaseOutputDTO
            {
                public List<CustomFieldDTO> CustomFields { get; set; }
            }

            public class UsingInvoiceResp : BaseOutputDTO
            {
                public int? Status { get; set; }
                public long? NumOfpublishInv { get; set; }
                public long? TotalInv { get; set; }
            }

            public class ConvertFontResp : BaseOutputDTO
            {
                public string Result { get; set; }
            }

            public class SearchUUIDResp : BaseOutputDTO
            {
                public string TransactionUuid { get; set; }
                public List<SearchUUIDInvoiceResult> Result { get; set; }
            }

            public class SearchUUIDRespTT78 : BaseOutputDTO
            {
                public string TransactionUuid { get; set; }
                public List<SearchUUIDInvoiceResultTT78> Result { get; set; }
            }
            [Serializable]
            public  class SearchUUIDInvoiceResult
            {
                public string SupplierTaxCode { get; set; }
                public string InvoiceNo { get; set; }
                public string ReservationCode { get; set; }
                public long IssueDate { get; set; }
                public string Status { get; set; }
                public string ExchangeStatus { get; set; }

                public SearchUUIDInvoiceResult() { }

                public SearchUUIDInvoiceResult(string supplierTaxCode, string invoiceNo, string reservationCode, long issueDate, string status, string exchangeStatus)
                {
                    SupplierTaxCode = supplierTaxCode;
                    InvoiceNo = invoiceNo;
                    ReservationCode = reservationCode;
                    IssueDate = issueDate;
                    Status = status;
                    ExchangeStatus = exchangeStatus;
                }
            }

            public class SearchUUIDInvoiceResultTT78 : SearchUUIDInvoiceResult
            {
                public string ExchangeDes { get; set; }
                public string CodeOfTax { get; set; }

                public override string ToString()
                {
                    return $"SearchUUIDInvoiceResultTT78{{ ExchangeStatus='{ExchangeStatus}', ExchangeDes='{ExchangeDes}', CodeOfTax='{CodeOfTax}' }}";
                }
            }

            public class HashResultResp : BaseOutputDTO
            {
                public Results Result { get; set; }
            }

            public class Results
            {
                public string HashString { get; set; }
            }           

            public  class SearchAllUUIDResp : BaseOutputDTO
            {
                private string transactionUuid;
                private List<SearchAllUUIDInvoiceResult> result;

                public string TransactionUuid
                {
                    get { return transactionUuid; }
                    set { transactionUuid = value; }
                }

                public List<SearchAllUUIDInvoiceResult> Result
                {
                    get { return result; }
                    set { result = value; }
                }
            }

            public  class SearchAllUUIDInvoiceResult
            {
                private string supplierTaxCode;
                private string serial;
                private string invoiceNo;
                private long issueDate;
                private int invoiceStatus;
                private string adjustmentType;
                private string adjustmentInvoiceType;

                public string SupplierTaxCode
                {
                    get { return supplierTaxCode; }
                    set { supplierTaxCode = value; }
                }

                public string InvoiceNo
                {
                    get { return invoiceNo; }
                    set { invoiceNo = value; }
                }

                public long IssueDate
                {
                    get { return issueDate; }
                    set { issueDate = value; }
                }

                public int InvoiceStatus
                {
                    get { return invoiceStatus; }
                    set { invoiceStatus = value; }
                }

                public string Serial
                {
                    get { return serial; }
                    set { serial = value; }
                }

                public string AdjustmentType
                {
                    get { return adjustmentType; }
                    set { adjustmentType = value; }
                }

                public string AdjustmentInvoiceType
                {
                    get { return adjustmentInvoiceType; }
                    set { adjustmentInvoiceType = value; }
                }
            }

            public  class CancelDraftResp : BaseOutputDTO
            {
                private string transactionUuid;
                private List<CancelDraftInvoiceResult> result;

                public string TransactionUuid
                {
                    get { return transactionUuid; }
                    set { transactionUuid = value; }
                }

                public List<CancelDraftInvoiceResult> Result
                {
                    get { return result; }
                    set { result = value; }
                }
            }

            public  class CancelDraftInvoiceResult
            {
                private string supplierTaxCode;
                private string serial;
                private string invoiceNo;
                private long issueDate;
                private int invoiceStatus;
                private string adjustmentType;
                private string adjustmentInvoiceType;
                private string invoiceTemplate;
                //private string status;

                public string SupplierTaxCode
                {
                    get { return supplierTaxCode; }
                    set { supplierTaxCode = value; }
                }

                public string InvoiceNo
                {
                    get { return invoiceNo; }
                    set { invoiceNo = value; }
                }

                public long IssueDate
                {
                    get { return issueDate; }
                    set { issueDate = value; }
                }

                public int InvoiceStatus
                {
                    get { return invoiceStatus; }
                    set { invoiceStatus = value; }
                }

                public string Serial
                {
                    get { return serial; }
                    set { serial = value; }
                }

                public string AdjustmentType
                {
                    get { return adjustmentType; }
                    set { adjustmentType = value; }
                }

                public string AdjustmentInvoiceType
                {
                    get { return adjustmentInvoiceType; }
                    set { adjustmentInvoiceType = value; }
                }

                /*public string Status
                {
                    get { return status; }
                    set { status = value; }
                }*/

                public string InvoiceTemplate
                {
                    get { return invoiceTemplate; }
                    set { invoiceTemplate = value; }
                }
            }

            public  class InvoicesAll : InvoicesOutput
            {
                private string listProduct;
                private string fileName;
                private string buyerUnitName;
                private string buyerCode;
                private string buyerAddress;
                private decimal exchangeRate;
                private string listInfoUpdate;

                public string FileName
                {
                    get { return fileName; }
                    set { fileName = value; }
                }

                public InvoicesAll() : base()
                {
                }

                public InvoicesAll(string adjustmentType, string buyerName, string buyerTaxCode, long createTime, string currency,
                                   long invoiceId, string invoiceNo, string invoiceNumber, string invoiceSeri, string invoiceType,
                                   long issueDate, int paymentStatus, string supplierTaxCode, decimal taxAmount, string templateCode,
                                   decimal total, decimal totalBeforeTax, int viewStatus, string issueDateStr, int state,
                                   long requestDate, string description, string buyerIdNo, int stateCode, long subscriberNumber,
                                   int downloadStatus, int exchangeStatus, int numOfExchange, long contractId, string contractNo,
                                   string taxRate, string paymentMethod, long paymentTime, long customerId, string no, string paymentStatusName,
                                   string listProduct, string fileName, string originalInvoiceNo)
                    : base(adjustmentType, buyerName, buyerTaxCode, createTime, currency, invoiceId, invoiceNo, invoiceNumber, invoiceSeri,
                           invoiceType, issueDate, paymentStatus, supplierTaxCode, taxAmount, templateCode, total, totalBeforeTax, viewStatus,
                           issueDateStr, state, requestDate, description, buyerIdNo, stateCode, subscriberNumber, downloadStatus, exchangeStatus,
                           numOfExchange, contractId, contractNo, taxRate, paymentMethod, paymentTime, customerId, no, paymentStatusName, originalInvoiceNo)
                {
                    this.listProduct = listProduct;
                    this.fileName = fileName;
                }

                public string ListProduct
                {
                    get { return listProduct; }
                    set { listProduct = value; }
                }

                public string BuyerUnitName
                {
                    get { return buyerUnitName; }
                    set { buyerUnitName = value; }
                }

                public string BuyerCode
                {
                    get { return buyerCode; }
                    set { buyerCode = value; }
                }

                public string BuyerAddress
                {
                    get { return buyerAddress; }
                    set { buyerAddress = value; }
                }

                public decimal ExchangeRate
                {
                    get { return exchangeRate; }
                    set { exchangeRate = value; }
                }

                public string ListInfoUpdate
                {
                    get { return listInfoUpdate; }
                    set { listInfoUpdate = value; }
                }
            }

            public  class InvoiceSearch : BaseOutputDTO
            {
                private long totalRows;
                private List<InvoicesAll> invoices;

                public long TotalRows
                {
                    get { return totalRows; }
                    set { totalRows = value; }
                }

                public List<InvoicesAll> Invoices
                {
                    get { return invoices; }
                    set { invoices = value; }
                }
            }

            public  class InfoViettelAI : BaseOutputDTO
            {
                private string url;
                private string tk;

                public string Url
                {
                    get { return url; }
                    set { url = value; }
                }

                public string Tk
                {
                    get { return tk; }
                    set { tk = value; }
                }
            }

        }
    }
}
