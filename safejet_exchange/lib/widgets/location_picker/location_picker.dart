import 'package:flutter/material.dart';
import 'package:country_picker/country_picker.dart';
import 'package:flutter/cupertino.dart';
import '../../config/theme/colors.dart';
import 'package:animate_do/animate_do.dart';
import 'dart:convert';

class CustomLocationPicker extends StatefulWidget {
  final bool isDark;
  final Function(String) onCountryChanged;
  final Function(String) onStateChanged;
  final Function(String) onCityChanged;
  final String? selectedCountry;
  final String? selectedState;
  final String? selectedCity;
  final bool isLoading;
  final String? errorMessage;

  const CustomLocationPicker({
    Key? key,
    required this.isDark,
    required this.onCountryChanged,
    required this.onStateChanged,
    required this.onCityChanged,
    this.selectedCountry,
    this.selectedState,
    this.selectedCity,
    this.isLoading = false,
    this.errorMessage,
  }) : super(key: key);

  @override
  State<CustomLocationPicker> createState() => _CustomLocationPickerState();
}

class _CustomLocationPickerState extends State<CustomLocationPicker> {
  List<dynamic>? _countryData;
  final TextEditingController _stateSearchController = TextEditingController();
  final TextEditingController _citySearchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadCountryData();
  }

  Future<void> _loadCountryData() async {
    try {
      final String data = await DefaultAssetBundle.of(context)
          .loadString('packages/country_state_city_picker/lib/assets/country.json');
      setState(() {
        _countryData = json.decode(data);
      });
    } catch (e) {
      print('Error loading country data: $e');
    }
  }

  List<String> _getStates(String country) {
    try {
      if (_countryData == null) return [];
      
      final countryData = _countryData!.firstWhere(
        (c) => c['name'] == country,
        orElse: () => null,
      );
      
      if (countryData == null) return [];
      
      final states = (countryData['state'] as List)
          .map((state) => state['name'].toString())
          .toList();
      
      states.sort((a, b) => a.compareTo(b));
      return states;
    } catch (e) {
      print('Error getting states: $e');
      return [];
    }
  }

  List<String> _getCities(String country, String state) {
    try {
      if (_countryData == null) return [];
      
      final countryData = _countryData!.firstWhere(
        (c) => c['name'] == country,
        orElse: () => null,
      );
      
      if (countryData == null) return [];
      
      final stateData = (countryData['state'] as List).firstWhere(
        (s) => s['name'] == state,
        orElse: () => null,
      );
      
      if (stateData == null) return [];
      
      final cities = (stateData['city'] as List)
          .map((city) => city['name'].toString())
          .toList();
      
      cities.sort((a, b) => a.compareTo(b));
      return cities;
    } catch (e) {
      print('Error getting cities: $e');
      return [];
    }
  }

  Widget _buildDropdownField({
    required String label,
    required String? value,
    required String hint,
    required IconData icon,
    bool enabled = true,
    required VoidCallback onTap,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: widget.isDark ? const Color(0xFF1A1A1A) : Colors.white,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: enabled ? onTap : null,
          borderRadius: BorderRadius.circular(12),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Icon(
                  icon,
                  color: widget.isDark ? Colors.white70 : Colors.black54,
                  size: 24,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        label,
                        style: TextStyle(
                          fontSize: 12,
                          color: widget.isDark ? Colors.white70 : Colors.black54,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        value?.isEmpty ?? true ? hint : value!,
                        style: TextStyle(
                          fontSize: 16,
                          color: value?.isEmpty ?? true
                              ? (widget.isDark ? Colors.white38 : Colors.black38)
                              : (widget.isDark ? Colors.white : Colors.black),
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  Icons.arrow_drop_down,
                  color: widget.isDark ? Colors.white70 : Colors.black54,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _showStatesPicker() {
    if (widget.selectedCountry == null) return;
    
    final states = _getStates(widget.selectedCountry!);
    if (states.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('No states found for selected country'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }

    List<String> filteredStates = states;

    showModalBottomSheet(
      context: context,
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => Container(
          height: MediaQuery.of(context).size.height * 0.7,
          padding: const EdgeInsets.symmetric(vertical: 20),
          child: Column(
            children: [
              Container(
                margin: const EdgeInsets.only(bottom: 20),
                width: 50,
                height: 5,
                decoration: BoxDecoration(
                  color: Colors.grey[300],
                  borderRadius: BorderRadius.circular(5),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  'Select State',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: CupertinoSearchTextField(
                  controller: _stateSearchController,
                  onChanged: (value) {
                    setModalState(() {
                      filteredStates = states
                          .where((state) => state.toLowerCase()
                              .contains(value.toLowerCase()))
                          .toList();
                    });
                  },
                  style: TextStyle(
                    color: Theme.of(context).textTheme.bodyLarge?.color,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (filteredStates.isEmpty) 
                Expanded(
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.search_off,
                          size: 48,
                          color: Colors.grey[400],
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'No states found',
                          style: TextStyle(
                            color: Colors.grey[600],
                            fontSize: 16,
                          ),
                        ),
                      ],
                    ),
                  ),
                )
              else
                Expanded(
                  child: ListView.builder(
                    itemCount: filteredStates.length,
                    itemBuilder: (context, index) => ListTile(
                      title: Text(filteredStates[index]),
                      onTap: () {
                        widget.onStateChanged(filteredStates[index]);
                        _stateSearchController.clear();
                        Navigator.pop(context);
                      },
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _showCitiesPicker() {
    if (widget.selectedState == null) return;
    
    final cities = _getCities(widget.selectedCountry!, widget.selectedState!);
    if (cities.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('No cities found for selected state'),
          backgroundColor: Colors.red,
        ),
      );
      return;
    }

    List<String> filteredCities = cities;

    showModalBottomSheet(
      context: context,
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, setModalState) => Container(
          height: MediaQuery.of(context).size.height * 0.7,
          padding: const EdgeInsets.symmetric(vertical: 20),
          child: Column(
            children: [
              Container(
                margin: const EdgeInsets.only(bottom: 20),
                width: 50,
                height: 5,
                decoration: BoxDecoration(
                  color: Colors.grey[300],
                  borderRadius: BorderRadius.circular(5),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  'Select City',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: CupertinoSearchTextField(
                  controller: _citySearchController,
                  onChanged: (value) {
                    setModalState(() {
                      filteredCities = cities
                          .where((city) => city.toLowerCase()
                              .contains(value.toLowerCase()))
                          .toList();
                    });
                  },
                  style: TextStyle(
                    color: Theme.of(context).textTheme.bodyLarge?.color,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (filteredCities.isEmpty) 
                Expanded(
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.search_off,
                          size: 48,
                          color: Colors.grey[400],
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'No cities found',
                          style: TextStyle(
                            color: Colors.grey[600],
                            fontSize: 16,
                          ),
                        ),
                      ],
                    ),
                  ),
                )
              else
                Expanded(
                  child: ListView.builder(
                    itemCount: filteredCities.length,
                    itemBuilder: (context, index) => ListTile(
                      title: Text(filteredCities[index]),
                      onTap: () {
                        widget.onCityChanged(filteredCities[index]);
                        _citySearchController.clear();
                        Navigator.pop(context);
                      },
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FadeInUp(
          duration: const Duration(milliseconds: 300),
          child: Column(
            children: [
              _buildDropdownField(
                label: 'Country',
                value: widget.selectedCountry,
                hint: 'Select Country',
                icon: Icons.public,
                onTap: () {
                  showCountryPicker(
                    context: context,
                    showPhoneCode: false,
                    countryListTheme: CountryListThemeData(
                      backgroundColor: widget.isDark ? const Color(0xFF1A1A1A) : Colors.white,
                      textStyle: TextStyle(
                        color: widget.isDark ? Colors.white : Colors.black,
                      ),
                      searchTextStyle: TextStyle(
                        color: widget.isDark ? Colors.white : Colors.black,
                      ),
                      bottomSheetHeight: 500,
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(20),
                        topRight: Radius.circular(20),
                      ),
                    ),
                    onSelect: (Country country) {
                      widget.onCountryChanged(country.name);
                    },
                  );
                },
              ),
              _buildDropdownField(
                label: 'State/Province',
                value: widget.selectedState,
                hint: 'Select State',
                icon: Icons.location_city,
                enabled: widget.selectedCountry != null && widget.selectedCountry!.isNotEmpty,
                onTap: _showStatesPicker,
              ),
              _buildDropdownField(
                label: 'City',
                value: widget.selectedCity,
                hint: 'Select City',
                icon: Icons.location_on,
                enabled: widget.selectedState != null && widget.selectedState!.isNotEmpty,
                onTap: _showCitiesPicker,
              ),
            ],
          ),
        ),
        if (widget.errorMessage != null)
          FadeIn(
            duration: const Duration(milliseconds: 200),
            child: Padding(
              padding: const EdgeInsets.only(left: 12, top: 8),
              child: Text(
                widget.errorMessage!,
                style: TextStyle(
                  color: SafeJetColors.error,
                  fontSize: 12,
                ),
              ),
            ),
          ),
      ],
    );
  }

  @override
  void dispose() {
    _stateSearchController.dispose();
    _citySearchController.dispose();
    super.dispose();
  }
} 