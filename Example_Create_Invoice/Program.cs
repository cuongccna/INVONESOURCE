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
    class Program
    {
        static async Task Main(string[] args)
        {            
            String accessToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX25hbWUiOiIwMTAwMTA5MTA2LTUwM190aGVnaW9pc3VhIiwic2NvcGUiOlsib3BlbmlkIl0sImV4cCI6MTczNjkzMTg1MywidHlwZSI6MSwiaWF0IjoxNzM2OTMxNTUzLCJpbnZvaWNlX2NsdXN0ZXIiOiJjbHVzdGVyNSIsImF1dGhvcml0aWVzIjpbIlJPTEVfVVNFUiJdLCJqdGkiOiI1ZjQyYzhiYy1kZDczLTQ3YTgtYWFmNS1hYzNiY2YyZGVhNWEiLCJjbGllbnRfaWQiOiJ3ZWJfYXBwIn0.G8sDgErqjxFygVQhE2Eq2vTsouQiusJiUrQxTJHFnIxu5Cz3w_AMnbxAGDDTU3tTUhe44sFoZdoRFt9G9GpwnPzNhIdjBZIv5boAGwe5aWJA8JutKeVqNd99v9DZoqF-q6-2gxEFScHfqCmITUGaXfa_qquUW4U2p8r2vIiYYNOZUkhKNNp1b_NVOAzLvCH8jjKPJWeHvmsrlYUbsEdhcJPu15Ey4wscquhx01VXUGVKbQufC-CY-puy1CkHBCrgXRUmJmVtNjiYKLgC6jCnax3X6aCPinKBFcT-qRd5uHrlpjvxAbl8sA9_cDM0YvAeIZptTaSiOJINiO7kUdO2ng";
            InvoiceSampleService invoiceSampleService = new InvoiceSampleService();
            //await invoiceSampleService.CancelInvoiceAsync(accessToken);
            //await invoiceSampleService.CreateInvoiceGTGTAsync(accessToken);
            //await invoiceSampleService.CreateInvoiceReplaceGTGTAsync(accessToken);
            //await invoiceSampleService.CreateInvoiceAdjustInfoGTGTAsync(accessToken);
            //await invoiceSampleService.CreateInvoiceAdjustMoneyGTGTAsync(accessToken);
            //await invoiceSampleService.SearchInvoiceByTransactionUuidAsync(accessToken);

            // PHIEU XUAT KHO
            //await invoiceSampleService.CreateInvoicePXKAsync(accessToken);
            await invoiceSampleService.CreateInvoiceReplacePXKAsync(accessToken);
            await invoiceSampleService.CreateInvoiceAdjustInfoPXKAsync(accessToken);
            await invoiceSampleService.CreateInvoiceAdjustMoneyPXKAsync(accessToken);
        }
    }
}
